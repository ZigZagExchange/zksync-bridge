import * as zksync from "zksync";
import ethers from 'ethers';
import dotenv from 'dotenv';
import * as Redis from 'redis';
import fs from 'fs';

dotenv.config();

// Connect to Redis
const redis_url = process.env.REDIS_URL;
const redis_use_tls = redis_url.includes("rediss");
const redis = Redis.createClient({ 
    url: redis_url,
    socket: {
        tls: redis_use_tls,
        rejectUnauthorized: false
    },
});
redis.on('error', (err) => console.log('Redis Client Error', err));
await redis.connect();

// Update last processed timestamp if necessary
const lastProcessedTimestamp = await redis.get("zksync:bridge:lastProcessedTimestamp");
const lastProcessedDate = new Date(lastProcessedTimestamp); 
const now = new Date();
const thirty_sec_ms = 30*1000;
// Nothing processed yet? Set the last process date to now
// NO OLD TXS processed
if (!lastProcessedDate) {
    await redis.set("zksync:bridge:lastProcessedTimestamp", now.toISOString());
}
// Last processed less than 30s ago?
// Set it to now. Better safe than sorry if you've been down for more than a restart.
// You can manually process anything that fell through. 
if (lastProcessedDate.getTime() < now.getTime() - thirty_sec_ms) {
    await redis.set("zksync:bridge:lastProcessedTimestamp", now.toISOString());
}

// Connect to ETH + Zksync
let syncWallet, syncProvider, ethWallet;
const ethersProvider = new ethers.providers.InfuraProvider(
    process.env.ETH_NETWORK,
    process.env.INFURA_PROJECT_ID,
);
try {
    syncProvider = await zksync.getDefaultRestProvider(process.env.ETH_NETWORK);
    ethWallet = new ethers.Wallet(process.env.ETH_PRIVKEY, ethersProvider);
    syncWallet = await zksync.Wallet.fromEthSigner(ethWallet, syncProvider);
    if (!(await syncWallet.isSigningKeySet())) {
        console.log("setting sign key");
        const signKeyResult = await syncWallet.setSigningKey({
            feeToken: "ETH",
            ethAuthType: "ECDSA",
        });
        console.log(signKeyResult);
    }
} catch (e) {
    console.log(e);
    throw new Error("Could not connect to zksync API");
}

// Load ERC-20 ABI
const ERC20_ABI = JSON.parse(fs.readFileSync('ERC20.abi'));


// Load supported tokens
const ETH_ADDRESS = '0x0000000000000000000000000000000000000000';
const SUPPORTED_TOKEN_IDS = process.env.SUPPORTED_TOKEN_IDS.split(',').map(v => parseInt(v)).filter(v => !isNaN(v));
const TOKEN_DETAILS = {};
for (let i in SUPPORTED_TOKEN_IDS) {
    const id = SUPPORTED_TOKEN_IDS[i];
    const details = await syncProvider.tokenInfo(id);
    TOKEN_DETAILS[id] = details;
}
console.log("Supported Tokens");
console.log(TOKEN_DETAILS);

// Set up Bridge queue
const BRIDGE_QUEUE = []

processNewWithdraws()
processBridgeQueue()

async function processNewWithdraws() {
    let account_txs;
    try {
        account_txs = await syncProvider.accountTxs(process.env.ZKSYNC_BRIDGE_ADDRESS, {
            from: 'latest', 
            limit: 25, 
            direction: 'older'
        });
    } catch (e) {
        console.error(e);
        console.error("Zksync API is down");
        setTimeout(processNewWithdraws, 5000);
        return false;
    }
    // Reverse the list and loop so that older transactions get processed first
    const reversed_txns = account_txs.list.reverse();
    for (let i in reversed_txns) {
        const tx = reversed_txns[i];
        const txType = tx.op.type;
        const sender = tx.op.from;
        const receiver = tx.op.to;
        const tokenId = tx.op.token;
        const amount = tx.op.amount;
        const txStatus = tx.status;
        const lastProcessedTimestamp = await redis.get("zksync:bridge:lastProcessedTimestamp");
        const lastProcessedDate = new Date(lastProcessedTimestamp); 
        const now = new Date();
        const txhash = tx.txHash;
        const timestamp = new Date(tx.createdAt);
        const isProcessed = await redis.get(`zksync:bridge:${txhash}:processed`);
        
        // Already processed or some other weird value is set? Continue
        if (isProcessed !== null) {
            continue;
        }
        
        // Tx type is not Transfer ? Mark as processed and update last process time
        if (txType !== "Transfer") {
            console.log("Unsupported tx type");
            await redis.set(`zksync:bridge:${txhash}:processed`, 1);
            await redis.set("zksync:bridge:lastProcessedTimestamp", tx.createdAt);
            continue;
        }


        // Ignore outgoing transactions
        if (sender.toLowerCase() === process.env.ZKSYNC_BRIDGE_ADDRESS.toLowerCase()) {
            console.log("IGNORE: Outgoing tx");
            await redis.set(`zksync:bridge:${txhash}:processed`, 1);
            await redis.set("zksync:bridge:lastProcessedTimestamp", tx.createdAt);
            continue;
        }

        if (receiver.toLowerCase() !== process.env.ZKSYNC_BRIDGE_ADDRESS.toLowerCase()) {
            console.log(tx);
            throw new Error("ABORT: Receiver does not match wallet");
        }

        // Status is rejected. Mark as processed and update last processed time
        if ((["rejected"]).includes(txStatus)) {
            console.log("Rejected tx");
            await redis.set(`zksync:bridge:${txhash}:processed`, 1);
            await redis.set("zksync:bridge:lastProcessedTimestamp", tx.createdAt);
            continue;
        }
        
        // Status is not committed? Ignore.
        if (!(["committed", "finalized"]).includes(txStatus)) {
            console.log("New transaction found but not committed");
            continue;
        }
        
        // Timestamp > now ? Suspicious. Mark it as processed and don't send funds. 
        // Also update the last processed date to the newest time so nothing before that gets processed just in case
        if (timestamp.getTime() > now.getTime()) {
            console.log("Sent in the future? wtf bro.");
            await redis.set(`zksync:bridge:${txhash}:processed`, 1);
            await redis.set("zksync:bridge:lastProcessedTimestamp", tx.createdAt);
            continue;
        }
        
        // Last processed > timestamp ? Unexpected behavior. Mark as processed and don't send funds. 
        if (lastProcessedDate.getTime() > timestamp.getTime()) {
            console.log("Timestamp before last processed. Tx got skipped");
            await redis.set(`zksync:bridge:${txhash}:processed`, 1);
            continue;
        }
        
        // Token is not supported ? Mark as processed and continue
        if (!SUPPORTED_TOKEN_IDS.includes(tokenId)) {
            console.log("transaction from unsupported token");
            console.log("Returning funds");
            await redis.set(`zksync:bridge:${txhash}:processed`, 1);
            await redis.set("zksync:bridge:lastProcessedTimestamp", tx.createdAt);
            const refundTransaction = await syncWallet.syncTransfer({
                to: sender,
                token: tokenId,
                amount,
                feeToken: 'ETH'
            });
            const receipt = await refundTransaction.awaitReceipt();
            console.log(refundTransaction);
            continue;
        }
        

        console.log("new tx", tx);

        // Check if there are sufficient funds in the L1 wallet
        // Refund the funds if not
        const tokenContractAddress = TOKEN_DETAILS[tokenId].address;
        let bridgeBalance;
        if (tokenContractAddress === ETH_ADDRESS) {
            bridgeBalance = await ethersProvider.getBalance(ethWallet.address);
        }
        else {
            const contract = new ethers.Contract(TOKEN_DETAILS[tokenId].address, ERC20_ABI, ethWallet);
            bridgeBalance = await contract.balanceOf(ethWallet.address);
        }
        if (ethers.BigNumber.from(amount).gt(bridgeBalance)) {
            console.log("amount too big. bridge has insufficient funds");
            console.log("refunding tx");
            await redis.set(`zksync:bridge:${txhash}:processed`, 1);
            await redis.set("zksync:bridge:lastProcessedTimestamp", tx.createdAt);
            const refundTransaction = await syncWallet.syncTransfer({
                to: sender,
                token: tokenId,
                amount,
                feeToken: 'ETH'
            });
            const receipt = await refundTransaction.awaitReceipt();
            console.log(refundTransaction);
            continue;
        }


        // Set the tx processed before you do anything to prevent accidental double spends
        await redis.set(`zksync:bridge:${txhash}:processed`, 1);
        await redis.set("zksync:bridge:lastProcessedTimestamp", tx.createdAt);

        // Get fee data and see if the tx amount is enough to pay fees
        const feeData = await ethersProvider.getFeeData();
        const bridgeFee = feeData.maxFeePerGas.mul(21000).mul(2);
        // Adjust for decimal difference, gas difference, and price difference
        const stableFee = (bridgeFee.toString() / 1e18 * process.env.ETH_PRICE_APPROX * 10**TOKEN_DETAILS[tokenId].decimals * 50000 / 21000).toFixed(0);
        let amountMinusFee;
        if (tokenContractAddress === ETH_ADDRESS) {
            console.log("Bridge Fee: ", bridgeFee.toString() / 1e18, " ETH");
            amountMinusFee = ethers.BigNumber.from(amount).sub(bridgeFee);
        }
        else {
            console.log("Stable Fee: ", stableFee / 10**TOKEN_DETAILS[tokenId].decimals, TOKEN_DETAILS[tokenId].symbol);
            amountMinusFee = ethers.BigNumber.from(amount).sub(stableFee);
        }
        if (amountMinusFee.lt(0)) {
            console.log("Bridge amount is too low");
            console.log("Refunding tx");
            const refundTransaction = await syncWallet.syncTransfer({
                to: sender,
                token: tokenId,
                amount,
                feeToken: 'ETH'
            });
            const receipt = await refundTransaction.awaitReceipt();
            console.log(refundTransaction);
            continue;
        }
            
        BRIDGE_QUEUE.push({ tokenContractAddress, sender, amountMinusFee, tokenId });
    }

    setTimeout(processNewWithdraws, 5000);
}

async function processBridgeQueue () {
    if (BRIDGE_QUEUE.length > 0) {
        const entry = BRIDGE_QUEUE.shift();
        if (entry.tokenContractAddress === ETH_ADDRESS) {
            console.log("Sending ETH on L1");
            try {
                const l1tx = await ethWallet.sendTransaction({
                    to: entry.sender,
                    value: entry.amountMinusFee.toString()
                });
                console.log(l1tx);
                console.log(`Waiting on transaction ${l1tx.hash} to be mined`);
                await l1tx.wait();
                console.log(`Transaction ${l1tx.hash} mined`);
            } catch (e) {
                console.log(e);
            }

            // If zksync side has more than 50 ETH, auto-bridge it
            const l2BridgeState = await syncWallet.getAccountState();
            console.log(l2BridgeState);
            const ethBalance = l2BridgeState.committed.balances.ETH / 1e18;
            if (ethBalance > process.env.MIN_AUTOSWEEP_FAST_BRIDGE) {
                console.log("ETH balance on L2: ", ethBalance);
                console.log("Withdrawing ETH to L1");
                const amount = (Number(process.env.MIN_AUTOSWEEP_FAST_BRIDGE) * 1e18).toString();
                const withdrawTx = await syncWallet.withdrawFromSyncToEthereum({
                    ethAddress: ethWallet.address,
                    token: 'ETH',
                    amount,
                });
                const receipt = await withdrawTx.awaitReceipt();
                console.log(withdrawTx);
            }
        }
        // ERC-20
        else {
            console.log("Sending ERC-20 on L1");
            const contract = new ethers.Contract(TOKEN_DETAILS[entry.tokenId].address, ERC20_ABI, ethWallet);
            try {
                const l1tx = await contract.transfer(entry.sender, entry.amountMinusFee.toString());
                console.log(l1tx);
                console.log(`Waiting on transaction ${l1tx.hash} to be mined`);
                await l1tx.wait();
                console.log(`Transaction ${l1tx.hash} mined`);
            } catch (e) {
                console.error(e);
            }
        }
    }
    setTimeout(processBridgeQueue, 5000);
}
