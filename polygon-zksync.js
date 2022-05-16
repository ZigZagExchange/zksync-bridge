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
redis.on('error', (err) => null);
await redis.connect();

// Connect to Ethereum
const ethersProvider = new ethers.providers.InfuraProvider(
    process.env.ETH_NETWORK,
    process.env.INFURA_PROJECT_ID,
);

// Connect to Polygon
const polygonProvider = new ethers.providers.JsonRpcProvider(
    process.env.POLYGON_NETWORK,
);

// Connect to zksync
const syncProvider = await zksync.getDefaultRestProvider(process.env.ETH_NETWORK);

// Set up Wallets
const ethWallet = new ethers.Wallet(process.env.POLYGON_PRIVKEY, ethersProvider);
const polygonWallet = new ethers.Wallet(process.env.POLYGON_PRIVKEY, polygonProvider);
const syncWallet = await zksync.Wallet.fromEthSigner(ethWallet, syncProvider);

// Set zksync Signing Key if necessary
//if (!(await syncWallet.isSigningKeySet())) {
//    console.log("setting sign key");
//    const signKeyResult = await syncWallet.setSigningKey({
//        feeToken: "ETH",
//        ethAuthType: "ECDSA",
//    });
//    console.log(signKeyResult);
//}

// Load ERC-20 ABI
const ERC20_ABI = JSON.parse(fs.readFileSync('ERC20.abi'));

// LOAD BLACKLIST
const BLACKLIST = (process.env.BLACKLIST && process.env.BLACKLIST.split(',').map(b => b.toLowerCase())) || [];


processNewDeposits()

async function processNewDeposits() {
    const contract = new ethers.Contract(process.env.POLYGON_ETH_ADDRESS, ERC20_ABI, polygonWallet);
    const filter = {
        topics: [ethers.utils.id("Transfer(address,address,uint256)")]
    }

    // Listen for our filtered results
    // TODO: Check how many confirmations before an event is sent
    contract.on(filter, async (sender, receiver, amount, event) => {
        const txhash = event.transactionHash;
        const blockNum = event.blockNumber;

        // Ignore any txs not sent to our address
        if (receiver.toLowerCase() !== polygonWallet.address.toLowerCase()) {
            return false;
        }

        console.log("New incoming tx");
        console.log(event);

        const lastProcessedBlockNum = Number(await redis.get(`polygon-zksync:lastProcessedBlockNum`) || "0");
        const lastProcessedLogIndex = Number(await redis.get(`polygon-zksync:lastProcessedLogIndex`) || "0");
        const isProcessed = await redis.get(`zksync:bridge:${txhash}:processed`);
        
        // Already processed or some other weird value is set? Continue
        if (isProcessed !== null) {
            console.log("Repeat transaction");
            return;
        }

        // Old transaction? Ignore and mark as processed
        if (lastProcessedBlockNum > blockNum) {
            console.log("Old transaction from old block. Ignoring");
            await redis.set(`zksync:bridge:${txhash}:processed`, 1);
            return;
        }
        else if (lastProcessedBlockNum === blockNum && lastProcessedLogIndex >= event.logIndex) {
            console.log("Out of order log index in block. Ignoring.");
            await redis.set(`zksync:bridge:${txhash}:processed`, 1);
            return;
        }
        
        // Sender is in blacklist? Ignore and mark as processed
        if (BLACKLIST.includes(sender.toLowerCase())) {
            console.log("Sender in blacklist. Ignoring");
            await redis.set(`zksync:bridge:${txhash}:processed`, 1);
            return;
        }

        // Wait 5 confirmations before proceeding
        try {
            await polygonProvider.waitForTransaction(txhash, 5);
        } catch (e) {
            console.error(e);
            console.error("ERROR: Bridge failed. Will have to bridge this tx manually");
            await redis.set(`polygon-zksync:${txhash}:processed`, 1);
            return false;
        }

        // Set the tx processed before you do anything to prevent accidental double spends
        await redis.set(`polygon-zksync:lastProcessedBlockNum`, blockNum);
        await redis.set(`polygon-zksync:lastProcessedLogIndex`, event.logIndex);
        await redis.set(`polygon-zksync:${txhash}:processed`, 1);

        // Get Bridge Balance
        const accountState = await syncWallet.getAccountState();
        const ethBalance = accountState.committed.balances.ETH || 0;

        // Compute Bridge Fee
        const feeDetails = await syncProvider.getTransactionFee("Transfer", accountState.address, "ETH");
        const bridgeFee = feeDetails.totalFee * 3;
        console.log("Bridge Fee: ", bridgeFee / 1e18, " ETH");

        // Send Transaction 
        // If the bridged amount is insufficient to cover the fee, ignore it
        let amountMinusFee = (amount - bridgeFee).toString();
        amountMinusFee = zksync.utils.closestPackableTransactionAmount(amountMinusFee);
        if (Number(amountMinusFee) > 0) {
            console.log("Sending ETH on zksync");
            try {
                const zksyncTx = await syncWallet.syncTransfer({
                    to: sender,
                    token: 'ETH',
                    amount: amountMinusFee.toString(),
                    feeToken: 'ETH'
                });
                console.log(zksyncTx);
                const receipt = await zksyncTx.awaitReceipt();
                console.log(receipt);
            } catch (e) {
                console.error(e);
            }
        }
        else {
            console.log("Insufficient quantity to bridge");
        }
        
    });
}

