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
const ethWallet = new ethers.Wallet(process.env.ETH_PRIVKEY, ethersProvider);
const polygonWallet = new ethers.Wallet(process.env.POLYGON_PRIVKEY, polygonProvider);
const syncWallet = await zksync.Wallet.fromEthSigner(ethWallet, syncProvider);

// Set zksync Signing Key if necessary
if (!(await syncWallet.isSigningKeySet())) {
    console.log("setting sign key");
    const signKeyResult = await syncWallet.setSigningKey({
        feeToken: "ETH",
        ethAuthType: "ECDSA",
    });
    console.log(signKeyResult);
}

// Load ERC-20 ABI
const ERC20_ABI = JSON.parse(fs.readFileSync('ERC20.abi'));


// Load supported tokens
processNewDeposits()

async function processNewDeposits() {
    const contract = new ethers.Contract(process.env.POLYGON_ETH_ADDRESS, ERC20_ABI, polygonWallet);
    const filter = {
        topics: [ethers.utils.id("Transfer(address,address,uint256)")]
    }

    // Listen for our filtered results
    // TODO: Check how many confirmations before an event is sent
    contract.on(filter, async (sender, receiver, amount, event) => {
        console.log(event);
        console.log(sender, receiver, amount, polygonWallet.address);
        const txhash = event.transactionHash;
        const blockNum = event.blockNumber;

        // Ignore any txs not sent to our address
        if (receiver.toLowerCase() !== polygonWallet.address.toLowerCase()) {
            await redis.set(`polygon-zksync:${event.address}:lastProcessedLogIndex`, event.logIndex);
            await redis.set(`polygon-zksync:${event.address}:lastProcessedTxIndex`, event.transactionIndex);
            await redis.set(`polygon-zksync:${txhash}:processed`, 1);
            return false;
        }

        const lastProcessedBlockNum = (await redis.get(`polygon-zksync:${event.address}:lastProcessedBlockNum`)) || "0";
        const lastProcessedTxIndex = (await redis.get(`polygon-zksync:${event.address}:lastProcessedLogIndex`)) || "0";
        const lastProcessedLogIndex = (await redis.get(`polygon-zksync:${event.address}:lastProcessedTxIndex`)) || "0";
        const isProcessed = await redis.get(`zksync:bridge:${txhash}:processed`);
        
        // Already processed or some other weird value is set? Continue
        if (isProcessed !== null) {
            console.log("Repeat transaction");
            return;
        }

        // log or transaction index > now ? Suspicious. Mark it as processed and don't send funds. 
        // Also update the last processed index to the newest time so nothing before that gets processed just in case
        if (lastProcessedTxIndex && Number(lastProcessedTxIndex) >= event.transactionIndex) {
            console.log("Out of order tx index? Strange.");
            await redis.set(`zksync:bridge:${txhash}:processed`, 1);
            return;
        }
        if (lastProcessedLogIndex && Number(lastProcessedLogIndex) >= event.logIndex) {
            console.log("Out of order log index? Strange.");
            await redis.set(`zksync:bridge:${txhash}:processed`, 1);
            return;
        }

        // Set the tx processed before you do anything to prevent accidental double spends
        await redis.set(`polygon-zksync:${event.address}:lastProcessedLogIndex`, event.logIndex);
        await redis.set(`polygon-zksync:${event.address}:lastProcessedTxIndex`, event.transactionIndex);
        await redis.set(`polygon-zksync:${txhash}:processed`, 1);

        // Get Bridge Balance
        const accountState = await syncWallet.getAccountState();
        const ethBalance = accountState.committed.balances.ETH || 0;

        // Compute Bridge Fee
        const feeDetails = await syncProvider.getTransactionFee("Transfer", syncWallet.address, "ETH");
        console.log(feeDetails);
        const bridgeFee = feeDetails.totalFee * 3;
        console.log("Bridge Fee: ", bridgeFee / 1e18, " ETH");

        // Send Transaction 
        // If the bridged amount is insufficient to cover the fee, ignore it
        const amountMinusFee = (amount - bridgeFee).toString();
        if (Number(amountMinusFee) > 0) {
            console.log("Sending ETH on zksync");
            const zksyncTx = syncWallet.syncTransfer(receiver, "ETH", amountMinusFee);
            const receipt = await zksyncTx.awaitReceipt();
            console.log(receipt);
        }
        else {
            console.log("Insufficient quantity to bridge");
        }
        
    });
}
