import https from 'https'
import commander from 'commander'
import autobahn from 'autobahn'
import Redis from 'redis'

commander
    .version('1.0.0')
    .option('-r, --redis <redisUrl>', 'Redis URL')
    .option('-w, --wamp <wampUrl>', 'WAMP URL')
    .option('-c, --channel <pubChannel>', 'Redis Publish Channel')
    .parse(process.argv)

let redisUrl = commander.redis ? commander.redis : 'redis://localhost:6379'
let wampUrl = commander.wamp ? commander.wamp : 'wss://api.poloniex.com'
let pubChannel = commander.channel ? commander.channel : 'socket-cc'

const RECONNECT_INTERVAL = 60000 // 1 min
const ERROR_RECONNECT_INTERVAL = 600000 // 10 min

console.log(wampUrl)
const socket = new autobahn.Connection({url: wampUrl, realm: 'realm1'})
const pubClient = Redis.createClient(redisUrl)
let watchDog = null

let marketHandler = (args, kwargs) => {
    console.log(args)
}

socket.onopen = connection => {
    console.log('opened')
    connection.subscribe('ticker', marketHandler)
}

socket.onclose = () => {
    console.log('disconnected')
}

socket.open()