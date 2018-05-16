import _ from 'lodash';
import Promise from 'bluebird';

import https from 'https';
import WebSocket from 'ws';

import commander from 'commander';
import Redis from 'redis';

Promise.promisifyAll(Redis.RedisClient.prototype)
Promise.promisifyAll(Redis.Multi.prototype)

const list = (val) => {
    return val.split(',').map((item) => {
        return item.trim();
    });
};

// parameters
commander
    .version('3.0.0')
    .option('--redis-url <redisUrl>', 'Redis URL', 'redis://localhost:6379')
    .option('--redis-prefix <redisPrefix>', 'Redis key prefix', 'orderbook')
    .option('--trade-channel <tradeChannel>', 'Trade info Redis channel', 'poloniex_trade')
    .option('--snapshot-interval <snapshotInterval>', 'Snapshot interval in ms', 60000)
    .option('--market <market>', 'Market list', list, ['BTC_ZEC', 'BTC_ETH', 'ETH_ZEC'])
    .parse(process.argv);

// constants
const WS_URL = 'wss://api2.poloniex.com';
const ORDERBOOK_URL_PREFIX = 'https://poloniex.com/public?command=returnOrderBook&currencyPair=';
const RECONNECT_INTERVAL = 60000 // 1 min
const ERROR_RECONNECT_INTERVAL = 600000 // 10 min
const OP_QUEUE_LIMIT = 1024
const TICK_DEPTH = 128

const redisClient = Redis.createClient(commander.redisUrl);

// generic helpers
const printLog = msg => {
    let now = new Date();
    console.log(now.toLocaleString(), msg);
    // console.trace()
};

const getOrderbookKey = (market, name) => {
    return commander.redisPrefix + ':' + market + ':' + name;
};

// helper - read orderbook snapshot from poloniex
const getOrderbook = (market) => {
    return new Promise((resolve, reject) => {
        https.get(`${ORDERBOOK_URL_PREFIX}${market}`, (res) => {
            let buffer = '';

            res.on('data', (data) => {
                buffer += data;
            });

            res.on('end', () => {
                // console.log(buffer)
                try {
                    let json = JSON.parse(buffer);
                    resolve(json);
                }
                catch (err) {
                    reject(err);
                }
            })

        })
        .on('error', err => {
            reject(err);
        });
    });
};

// helper - refresh entire orderbook in redis
const refreshOrderbook = async (market, orderbook) => {
    let asks = orderbook.asks;
    let bids = orderbook.bids;

    let commands = redisClient.multi()
        .del(getOrderbookKey(market, 'asks.sset'))
        .del(getOrderbookKey(market, 'asks.hash'))
        .del(getOrderbookKey(market, "bids.sset"))
        .del(getOrderbookKey(market, 'bids.hash'))
        .set(getOrderbookKey(market, 'frozen'), orderbook['isFrozen'])
        .set(getOrderbookKey(market, 'seq'), orderbook['seq']);

    asks.map((ask) => {
        commands.zadd(getOrderbookKey(market, 'asks.sset'), parseFloat(ask[0]), ask[0]);
        commands.hset(getOrderbookKey(market, 'asks.hash'), ask[0], ask[1]);
    });

    bids.map((bid) => {
        commands.zadd(getOrderbookKey(market, "bids.sset"), parseFloat(bid[0]), bid[0]);
        commands.hset(getOrderbookKey(market, 'bids.hash'), bid[0], bid[1]);
    });

    try {
        await commands.execAsync();
    } catch (err) {
        printLog(err);
    }
};

// interface - refresh orderbook snapshot in redis
const refreshSnapshot = async (market) => {
    try {
        const orderbook = await getOrderbook(market);
        await refreshOrderbook(market, orderbook);
    } catch (err) {
        printLog(err);
    }
};

// helper - read asks / bids from redis
const readDepth = async (market, limit, askFlag) => {
    try {
        let vals = await redisClient.zrangeAsync(
            getOrderbookKey(market, askFlag ? 'asks.sset' : 'bids.sset'),
            0,
            limit
        );
        
        if (
            vals === undefined ||
            vals == null
        ) {
            vals = [];
        }

        if (vals.length !== 0) {
            const Qs = await redisClient.hmgetAsync(
                getOrderbookKey(market, askFlag ? 'asks.hash' : 'bids.hash'),
                vals
            );

            vals = [vals, Qs];
        }

        return vals;
    } catch (err) {
        printLog(err);
    }
};

// interface - read orderbook snapshot from redis
const readSnapshot = async (market, limit) => {
    // WARNING : current implementation does NOT support multiple redis clients
    // limit = -1 to get full depth
    try {
        const asks = await readDepth(market, limit, true);
        const bids = await readDepth(market, limit, false);

        const frozen = await client.getAsync(getOrderbookKey(market, 'frozen'));
        const seq = await client.getAsync(getOrderbookKey(market, 'seq'));

        return {
            market,
            asks,
            bids,
            frozen,
            seq
        };
    } catch (err) {
        printLog(err);
    }
};

// helper - booking
const booking = (market, op, commands) => {
    switch(op.type) {
        case 'orderBookModify':
        commands.zadd(getOrderbookKey(market, op.data['type'] + 's.sset'), parseFloat(op.data['rate']), op.data['rate'])
        commands.hset(getOrderbookKey(market, op.data['type'] + 's.hash'), op.data['rate'], op.data['amount'])
        break;

        case 'orderBookRemove':
        commands.zrem(getOrderbookKey(market, op.data['type'] + 's.sset'), op.data['rate'])
        commands.hdel(getOrderbookKey(market, op.data['type'] + 's.hash'), op.data['rate'])
        break;

        default:
        // do nothing
        break;
    }

    return commands;
};

// helper - send orderbook snapshot to redis
const sendTick = async (market, depth) => {
    try {
        const orderbook = await readSnapshot(market, depth);
        await redisClient.publish(market, JSON.stringify(orderbook));
    } catch (err) {
        printLog(err);
    }
}

// helper - cache received future msgs, and check for msg lossing
let storeMsg = async (market, msg, queueLimit) => {
    // console.log('storeMsg', 'msg.seq', msg.seq)

    try {
        await redisClient.zaddAsync(
            getOrderbookKey(market, 'ops'),
            msg.seq,
            JSON.stringify(msg)
        );
    
        let count = await redisClient.zcardAsync(getOrderbookKey(market, 'ops'));
        count = parseInt(count);

        if (count > queueLimit) {
            // consider we have lost op(s), discard op queue and refresh orderbook
            await redisClient.del(getOrderbookKey(market, 'ops'));
            await refreshSnapshot(market);
        }
    } catch (err) {
        printLog(err);
    }
};

// helper - check if we have next msg to execute
const execStoredMsgs = async (market, depth) => {
    try {
        let seq = await redisClient.getAsync(getOrderbookKey(market, 'seq'));
        seq = parseInt(seq);

        let storedMsgs = await redisClient.zrangeAsync(
            getOrderbookKey(market, 'ops'),
            0,
            -1
        );
        storedMsgs = storedMsgs.map(JSON.parse);

        if (
            storedMsgs !== undefined &&
            storedMsgs != null &&
            storedMsgs.length !== 0
        ) {
            // got stored msgs, start to check
            const commands = redisClient.multi();
            let commandFlag = false;

            storedMsgs.map((storedMsg) => {
                if (seq + 1 == storedMsg.seq) {
                    // ok, got next, execute
                    commandFlag = true;

                    storedMsg.ops.map((op) => {
                        booking(market, op, commands);
                    });

                    commands.zrem(
                        getOrderbookKey(market, 'ops'),
                        JSON.stringify(storedMsg)
                    );

                    commands.incr(getOrderbookKey(market, 'seq'));

                    seq++;
                } else if (seq + 1 > storedMsg.seq) {
                    // remove expired msg
                    commandFlag = true;

                    commands.zrem(
                        getOrderbookKey(market, 'ops'),
                        JSON.stringify(storedMsg)
                    );
                } else {
                    // future msg, let it be...
                    // do nothing
                }
            });

            if (commandFlag) {
                // execute and send latest tick - we may have skipped multiple ticks
                await commands.exec();
                await sendTick(market, depth);
            } else {
                commands.discard();
            }
        }
    } catch (err) {
        printLog(err);
    }
};

// interface - handles each message received
const messageHandler = async (market, msg) => {
    try {
        let seq = await redisClient.getAsync(getOrderbookKey(market, 'seq'));

        if (
            seq !== undefined &&
            seq != null
        ) {
            seq = parseInt(seq);

            if (seq + 1 === msg.seq) {
                // ok, we just got next msg
                const commands = redisClient.multi();

                msg.ops.map((op) => {
                    booking(market, op, commands);
                });

                commands.incr(getOrderbookKey(market, 'seq'));

                const replies = await commands.execAsync();
                await sendTick(market, TICK_DEPTH);
            } else if (seq + 1 < msg.seq) {
                // got a future msg, cache
                await storeMsg(market, msg, OP_QUEUE_LIMIT);
            } else {
                // expired msg, drop
                // do nothing
            }

            // see if we have next msg already stored in redis
            await execStoredMsgs(market, TICK_DEPTH);

            return;
        }
        
        // orderbook not ready yet, just store msg
        await storeMsg(market, msg, OP_QUEUE_LIMIT);
    } catch (err) {
        printLog(err);
    }
};

// data wrappers
const orderbookWrapper = (rawOp, seq) => {
    let orderbook = null;

    try {
        orderbook = rawOp[1].orderBook;
        let asks = _.toPairs(orderbook[0]);
        let bids = _.toPairs(orderbook[1]);
        orderbook = {asks: asks, bids: bids, isFrozen: 0, seq: parseInt(seq)};
    }
    catch(err) {
        printLog(err);
    }
    finally {
        return orderbook;
    }
};

const opWrapper = (rawOp) => {
    let arg = null;

    try {
        arg = {type: 'orderBookModify'};
        
        if (rawOp[3] == '0.00000000') {
            arg.type = 'orderBookRemove';
            arg['data'] = {rate: rawOp[2]};
        }
        else {
            arg['data'] = {rate: rawOp[2], amount: rawOp[3]};
        }
    
        if (rawOp[1] == 0)
            arg.data['type'] = 'ask';
        else
            arg.data['type'] = 'bid';
    }
    catch(err) {
        printLog(err);
    }
    finally {
        return arg;
    }
};

// main entry
commander.market.map((market) => {
        // open websocket for each market
        const ws = new WebSocket(WS_URL);

        ws.on('open', () => {
            printLog(`WebSocket connected to ${WS_URL}`);
            ws.send(JSON.stringify({command: 'subscribe', channel: market}));
            printLog(`Subscribing to ${market}`);
        });

        ws.on('message', async (msg) => {
            // [178,91878377,[["o",1,"0.05013632","0.00000000"],["o",1,"0.05011473","178.09400000"]]]

            try {
                const message = JSON.parse(msg)

                const opCode = message[0]
                const seq = message[1]
                const rawOps = message[2]
    
                switch(opCode) {
                    case 1001:
                    // trollbox event
                    break
    
                    case 1002:
                    // tick event
                    break
    
                    case 1010:
                    // heartbeat
                    break
    
                    default:
                    if (opCode > 0 && opCode < 1000) {
                        // orderbook event
                        let ops = await Promise.mapSeries(rawOps, async (rawOp) => {
                            switch (rawOp[0]) {
                                case 'i':
                                // init market orderbook
                                const orderbook = orderbookWrapper(rawOp, seq);
                                if (orderbook != null) {
                                    await refreshOrderbook(market, orderbook);
                                }
                                return null;
                                break;

                                case 'o':
                                // convert to api version1 op
                                const arg = opWrapper(rawOp);
                                return arg;
                                break;

                                case 't':
                                // trade
                                const trade = {
                                    tradeID: rawOp[1],
                                    type: (rawOp[2] == 1 ? 'buy' : 'sell'),
                                    rate: rawOp[3],
                                    amount: rawOp[4],
                                    total: parseFloat(rawOp[3]) * parseFloat(rawOp[4]),
                                    ts: rawOp[5],
                                    market
                                };
                                await redisClient.publishAsync(
                                    commander.tradeChannel,
                                    JSON.stringify(trade)
                                );
                                return null;
                                break;

                                default:
                                printLog('Unknown message type');
                                return null;
                                break;
                            }
                        });

                        ops = ops.filter((curr) => {
                            return (curr != null);
                        });
            
                        if (ops.length !== 0) {
                            const msgData = {
                                ops,
                                seq
                            };
                            await messageHandler(market, msgData);
                        }
                    } // if 0 < opCode < 1000
                    break; // default
                }
            }
            catch(err) {
                printLog(err);
            }
        }); // ws on message

        ws.on('disconnect', () => {
            printLog(`Websocket disconnected from ${WS_URL}`);
        });
});
