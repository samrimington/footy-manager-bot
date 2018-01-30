const bodyParser = require('body-parser');
const express = require('express');
const fs = require('fs');
const ngrok = require('ngrok');
const request = require('request');
const {WebClient, RtmClient, CLIENT_EVENTS, RTM_EVENTS} = require('@slack/client');

const config = fs.readFileSync('config.json');
const token = config.token;
const footballChannelId = config.footballChannelId;

const app = express();
const urlencodedParser = bodyParser.urlencoded({extended: false});
const web = new WebClient(token);
const rtm = new RtmClient(token, {
    dataStore: false,
    useRtmConnect: true
});

class Bot {
    constructor(selfId, matchDay = 2) {
        this.selfId = selfId;
        this.matchDay = matchDay;
    }

    nextGameMs() {
        let now = new Date();
        let gameDate = new Date();
        gameDate.setDate(now.getDate() + ((this.matchDay - now.getDay() % 7) + 7) % 7);
        gameDate.setHours(18);
        gameDate.setMinutes(30);
        gameDate.setSeconds(0);
        return gameDate - now;
    }

    isMatchDay() {
        let now = new Date();
        return now.getDay() == this.matchDay;
    }

    helpMessage() {
        return {headline: "Supported commands: *help, when, poll, teams*"};
    }

    whenMessage() {
        let nextGameSec = this.nextGameMs() / 1000;
        let days = Math.floor(nextGameSec/86400);
        let remainder = nextGameSec % 86400;
        let hours = Math.floor(remainder/3600);
        remainder = remainder % 3600;
        let minutes = Math.floor(remainder/60);
        let seconds = remainder % 60;
        return {headline: `The next game will be in ${days} days, ${hours} hours, ${minutes} minutes and ${seconds} seconds`};
    }

    unknownMessage() {
        return {headline: "Not sure what you mean. Try `@Footy Manager Bot help`"};
    }

    interpretSlackMessage(message) {
        if (message.subtype && (message.subtype === 'bot_message' || message.subtype === 'message_changed' || message.subtype === 'message_deleted') || message.text && message.text.indexOf(`<@${this.selfId}>`) < 0) {
            return;
        }
        console.log('New direct mention: ', message);
        if (/\shelp(\W|\b)/i.test(message.text)) {
            return 'help';
        } else if (/\s(when|time|game|match)(\W|\b)/i.test(message.text)) {
            return 'when';
        } else if (/\spoll(\W|\b)/i.test(message.text)) {
            return 'poll';
        } else if (/\steams?(\W|\b)/i.test(message.text)) {
            return 'teams';
        } else {
            return 'unknown';
        }
    }
}

class GamePoll {
    constructor(channelId) {
        this.poll = {};
        this.channelId = channelId;
        this.__teams = null;
    }

    init(members) {
        var self = this;
        return new Promise(function (resolve, reject) {
            for (var i in members) {
                self.poll[`<@${members[i]}>`] = 'unknown';
            }
            if (self.poll.length <= 0) {
                reject(false);
            } else {
                resolve(true);
            }
        });
    }

    change(user, response) {
        var self = this;
        return new Promise(function (resolve) {
            let userEntry = `<@${user}>`;
            // TODO evaluate response
            if (userEntry in self.poll) {
                if (!(self.poll[userEntry] == 'unknown' && response == 'no')) {
                    self.__teams = null;
                }
                self.poll[userEntry] = response;
                resolve(true);
            } else {
                reject(false);
            }
        });
    }

    result() {
        let result = {yes: [], no: [], unknown: []};
        for (var user in this.poll) {
            result[this.poll[user]].push(user);
        }
        return result;
    }

    async teams() {
        if (this.__teams) {
            return this.__teams;
        } else {
            let players = await this.result().yes;
            if (players.length >= 4) {
                let teams = {home: [], away: []};
                for (var i = 0; i <= Math.floor(players.length / 2); i++) {
                    let choice = Math.floor(Math.random() * players.length);
                    teams.away.push(players[choice]);
                    players.splice(choice, 1);
                }
                teams.home = players;
                this.__teams = teams;
                return this.__teams;
            } else {
                return;
            }
        }
    }

    async pollMessage() {
        let result = await this.result();
        return {
            headline: "Ok - who's coming to the match tonight?",
            opts: {
                "attachments": [
                    {
                        "text": `:+1: Sure!    \`${result.yes.length}\`\n${result.yes}\n\n:-1: Nah    \`${result.no.length}\`\n${result.no}\n\n:question: No answer    \`${result.unknown.length}\`\n${result.unknown}`,
                        "fallback": "You cannot choose an option at this time",
                        "callback_id": "weekly_game",
                        "attachment_type": "default",
                        "actions": [
                            {
                                "name": "weekly_game_res",
                                "text": "Sure!",
                                "type": "button",
                                "value": "yes"
                            },
                            {
                                "name": "weekly_game_res",
                                "text": "Nah",
                                "type": "button",
                                "value": "no",
                                "confirm": {
                                    "title": "Are you sure?",
                                    "text": "Why not, the more the merrier!",
                                    "ok_text": "I'm sure",
                                    "dismiss_text": "No, wait!"
                                }
                            }
                        ]
                    }
                ]
            }
        };
    }

    async teamsMessage() {
        let teams = await this.teams();
        if (teams) {
            return {
                headline: `Teams so far in <#${this.channelId}>:`,
                opts: {
                    "attachments": [
                        {
                            "text": `:house: Home    \`${teams.home.length}\`\n${teams.home}\n\n:car: Away    \`${teams.away.length}\`\n${teams.away}`
                        }
                    ]
                }
            };
        } else {
            return {headline: "Not enough players! :slightly_frowning_face:"};
        }
    }
}

var myBot;
var myPoll;
var latestPollMessageTs;

async function resetPoll() {
    myPoll = null;
    latestPollMessageTs = null;
    let nextTimeMs = await myBot.nextGameMs();
    console.log(`myPoll restarted - next restart in ${nextTimeMs/1000} seconds`);
    setTimeout(function () {
        resetPoll();
    }, nextTimeMs);
}

function sendMessage(channel, message) {
    return new Promise(function (resolve, reject) {
        web.chat.postMessage(channel, message.headline, message.opts)
        .then(function (res) {
            console.log('Message sent: ', res.ts);
            resolve(res.ts);
        })
        .catch(console.error, function () {
            reject(false);
        });
    });
}

rtm.on(CLIENT_EVENTS.RTM.AUTHENTICATED, function (connectData) {
    myBot = new Bot(connectData.self.id);
    resetPoll();
    console.log(`Bot activated as ${connectData.self.id} of team ${connectData.team.id}`);
});
rtm.on(RTM_EVENTS.MESSAGE, async function (message) {
    let keyword = await myBot.interpretSlackMessage(message);
    var response;
    if (keyword) {
        switch (keyword) {
            case 'help':
                sendMessage(message.channel, myBot.helpMessage());
                break;
            case 'when':
                sendMessage(message.channel, myBot.whenMessage());
                break;
            case 'poll':
                if (message.channel !== footballChannelId) {
                    sendMessage(message.channel, {headline: `Sorry, I can only start a poll in <#${footballChannelId}>`});
                } else if (!myBot.isMatchDay()) {
                    sendMessage(message.channel, {headline: "Poll not available until next Tuesday"});
                } else if (!myPoll) {
                    myPoll = new GamePoll(message.channel);
                    web.channels.info(myPoll.channelId)
                    .then(function (res) {
                        myPoll.init(res.channel.members)
                        .then(async function () {
                            sendMessage(message.channel, await myPoll.pollMessage())
                            .then(function (ts) {
                                latestPollMessageTs = ts;
                            })
                            .catch(console.error);
                        })
                        .catch(console.error);
                    })
                    .catch(console.error);
                } else {
                    if (latestPollMessageTs) {
                        web.chat.delete(latestPollMessageTs, message.channel)
                        .then(function () {
                            console.log('Old poll message deleted');
                        })
                        .catch(console.error);
                    }
                    sendMessage(message.channel, await myPoll.pollMessage())
                    .then(function (ts) {
                        latestPollMessageTs = ts;
                    })
                    .catch(console.error);
                }
                break;
            case 'teams':
                if (myBot.isMatchDay()) {
                    if (myPoll) {
                        sendMessage(message.channel, await myPoll.teamsMessage());
                    } else {
                        sendMessage(message.channel, {headline: "No poll has been started this week!"});
                    }
                } else {
                    sendMessage(message.channel, {headline: "Teams not available until next Tuesday"});
                }
                break;
            case 'unknown':
                sendMessage(message.channel, myBot.unknownMessage());
                break;
        }
    }
});
rtm.start();

app.post('/slack/action', urlencodedParser, function (req, res) {
    res.status(200).end();
    let payload = JSON.parse(req.body.payload);
    if (myPoll && payload.actions[0].name == "weekly_game_res") {
        myPoll.change(payload.user.id, payload.actions[0].value)
        .then(async function () {
            let response = await myPoll.pollMessage();
            console.log(latestPollMessageTs);
            web.chat.update(latestPollMessageTs, myPoll.channelId, response.headline, response.opts)
            .then(function (res) {
                console.log('Message update sent: ', res.ts);
            })
            .catch(console.error);
        })
        .catch(console.error);
    }
});
app.listen(8081);

ngrok.connect({
    proto: 'http',
    addr: 8081
}, function (err, url) {
    if (err) {
        console.error(`Error loading ngrok: ${err}`);
    } else {
        console.log(`ngrok url: ${url}`);
    }
});
