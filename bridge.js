import * as zksync from "zksync";
import ethers from 'ethers';
import dotenv from 'dotenv';
import * as Redis from 'redis';

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
const five_min_ms = 5*60*1000;
// Nothing processed yet? Set the last process date to now
// NO OLD TXS processed
if (!lastProcessedDate) {
    await redis.set("zksync:bridge:lastProcessedTimestamp", now.toISOString());
}
// Last processed less than 5 min ago?
// Set it to now. Better safe than sorry if you've been down for that long. 
// You can manually process anything that fell through. 
if (lastProcessedDate.getTime() < now.getTime() - five_min_ms) {
    await redis.set("zksync:bridge:lastProcessedTimestamp", now.toISOString());
}

// Connect to ETH + Zksync
let syncWallet, ethersProvider, syncProvider, ethWallet;
ethersProvider = ethers.getDefaultProvider(process.env.ETH_NETWORK);
try {
    syncProvider = await zksync.getDefaultRestProvider(process.env.ETH_NETWORK);
    ethWallet = new ethers.Wallet(process.env.ETH_PRIVKEY);
    syncWallet = await zksync.Wallet.fromEthSigner(ethWallet, syncProvider);
} catch (e) {
    console.log(e);
    throw new Error("Could not connect to zksync API");
}

// Load supported tokens
const ETH_ADDRESS = '0x0000000000000000000000000000000000000000';
const SUPPORTED_TOKEN_IDS = process.env.SUPPORTED_TOKEN_IDS.split(',').filter(v => v !== '');
const TOKEN_DETAILS = {};
for (let i in SUPPORTED_TOKEN_IDS) {
    const id = SUPPORTED_TOKEN_IDS[i];
    const details = await syncProvider.tokenInfo(id);
    console.log(details);
    TOKEN_DETAILS[id] = details;
}


processNewWithdraws()
//setInterval(processNewWithdraws, 3000);

async function processNewWithdraws() {
    const account_txs = await syncProvider.accountTxs(ethWallet.address, {
        from: 'latest', 
        limit: 5, 
        direction: 'older'
    });
    // Reverse the list and loop so that older transactions get processed first
    console.log(account_txs);
    const reversed_txns = account_txs.list.reverse();
    for (let i in reversed_txns) {
        const tx = reversed_txns[i];
        console.log(tx.op);
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
            return true;
        }

        
        // Receiver doesn't match expected? Abort. Why is the API broken? 
        if (receiver.toLowerCase() !== ethWallet.address.toLowerCase()) {
            throw new Error("ABORT: Receiver does not match wallet");
        }
        
        // Status is not committed? Ignore.
        if (txStatus !== "committed") {
            return true;
        }
        
        // Token is not supported ? Mark as processed and continue
        if (!SUPPORTED_TOKEN_IDS.includes(tokenId)) {
            await redis.set(`zksync:bridge:${txhash}:processed`, 1);
            await redis.set("zksync:bridge:lastProcessedTimestamp", tx.createdAt);
            return true;
        }
        
        // Tx type is not Transfer ? Mark as processed and update last process time
        if (txType !== "Transfer") {
            await redis.set(`zksync:bridge:${txhash}:processed`, 1);
            await redis.set("zksync:bridge:lastProcessedTimestamp", tx.createdAt);
            return true;
        }

        // Timestamp > now ? Suspicious. Mark it as processed and don't send funds. 
        // Also update the last processed date to the newest time so nothing before that gets processed just in case
        if (timestamp.getTime() > now.getTime()) {
            await redis.set(`zksync:bridge:${txhash}:processed`, 1);
            await redis.set("zksync:bridge:lastProcessedTimestamp", tx.createdAt);
            return true;
        }
        
        // Last processed > timestamp ? Unexpected behavior. Mark as processed and don't send funds. 
        if (lastProcessedDate.getTime() > timestamp.getTime()) {
            await redis.set(`zksync:bridge:${txhash}:processed`, 1);
            return true;
        }

        // Time to actually send this thing
        const contractAddress = TOKEN_DETAILS[id].address;
        if (contractAddress === ETH_ADDRESS) {
            ethWallet.sendTransaction({
                to: sender,
                value: amount
            });
        }
        else {
            //ethWallet
        }
    }
}
