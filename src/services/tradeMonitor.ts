import moment from 'moment';
import { ENV } from '../config/env';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel, getUserPositionModel } from '../models/userHistory';
import fetchData from '../utils/fetchData';

const USER_ADDRESS = ENV.USER_ADDRESS;
const TOO_OLD_TIMESTAMP = ENV.TOO_OLD_TIMESTAMP;
const FETCH_INTERVAL = ENV.FETCH_INTERVAL;

if (!USER_ADDRESS) {
    throw new Error('USER_ADDRESS is not defined');
}

const UserActivity = getUserActivityModel(USER_ADDRESS);
const UserPosition = getUserPositionModel(USER_ADDRESS);

let seenTransactionHashes: Set<string> = new Set();

const init = async () => {
    const existingTrades = await UserActivity.find().exec();
    seenTransactionHashes = new Set(
        existingTrades.map((trade) => trade.transactionHash).filter((hash): hash is string => Boolean(hash))
    );
    console.log(`Loaded ${seenTransactionHashes.size} existing transaction hashes`);
};

const fetchTradeData = async () => {
    const user_positions: UserPositionInterface[] = await fetchData(
        `https://data-api.polymarket.com/positions?user=${USER_ADDRESS}`
    );
    const user_activities: UserActivityInterface[] = await fetchData(
        `https://data-api.polymarket.com/activity?user=${USER_ADDRESS}&limit=100&offset=0`
    );

    if (user_positions.length > 0) {
        const bulkOps = user_positions.map((position) => ({
            updateOne: {
                filter: { conditionId: position.conditionId },
                update: { $set: position },
                upsert: true,
            },
        }));
        await UserPosition.bulkWrite(bulkOps);
    }

    try {
        const currentTimestamp = Math.floor(moment().valueOf() / 1000);
        const new_trades = user_activities
            .filter((activity: UserActivityInterface) => {
                return !seenTransactionHashes.has(activity.transactionHash);
            })
            .filter((activity: UserActivityInterface) => {
                return activity.timestamp + TOO_OLD_TIMESTAMP * 60 * 60 > currentTimestamp;
            })
            .map((activity: UserActivityInterface) => {
                return { ...activity, bot: false, botExcutedTime: 0 };
            })
            .sort(
                (a: { timestamp: number }, b: { timestamp: number }) => a.timestamp - b.timestamp
            );

        if (new_trades.length > 0) {
            await UserActivity.insertMany(new_trades);
            new_trades.forEach((trade) => seenTransactionHashes.add(trade.transactionHash));
            console.log(`Added ${new_trades.length} new trades`);
        }

        const oldHashCount = seenTransactionHashes.size;
        if (oldHashCount > 10000) {
            const recentTrades = await UserActivity.find({
                timestamp: { $gt: currentTimestamp - TOO_OLD_TIMESTAMP * 60 * 60 }
            }).exec();
            seenTransactionHashes = new Set(
                recentTrades.map((trade) => trade.transactionHash).filter((hash): hash is string => Boolean(hash))
            );
            console.log(`Cleaned up hash Set: ${oldHashCount} -> ${seenTransactionHashes.size}`);
        }
    } catch (error) {
        console.error('Error inserting new trades:', error);
    }
};

const tradeMonitor = async () => {
    console.log('Trade Monitor is running every', FETCH_INTERVAL, 'seconds');
    await init();
    while (true) {
        await fetchTradeData();
        await new Promise((resolve) => setTimeout(resolve, FETCH_INTERVAL * 1000)); 
    }
};

export default tradeMonitor;
