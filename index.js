const express = require('express');
const fs = require('fs');
const request = require('request');
const bodyParser = require('body-parser');
const {WebClient, RtmClient, CLIENT_EVENTS, RTM_EVENTS} = require('@slack/client');
const ngrok = require('ngrok');
const shuffle = require('shuffle-array');

const UNKNOWN = 0;
const YES = 1;
const NO = 2;
const HOME = 0;
const AWAY = 1;

const config = JSON.parse(fs.readFileSync('/srv/config.json'));
const slackToken = config.slackToken;
const footballChannelId = config.footballChannelId;
const ngrokToken = config.ngrokToken;
const adminUserId = config.adminUserId;
const appId = config.appId;

const app = express();
const urlencodedParser = bodyParser.urlencoded({extended: false});
const web = new WebClient(slackToken);
const rtm = new RtmClient(slackToken, {
    dataStore: false,
    useRtmConnect: true
});

class Bot {
    constructor(selfId, matchDay = 2) {
        this.selfId = selfId;
        this.matchDay = matchDay;
    }

    // TODO This might produce the wrong answer once Tuesday comes
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
        this.channelId = channelId;
    }

    reset(members) {
        var self = this;
        return new Promise(function (resolve, reject) {
            self.poll = {};
            self._teams = null;
            shuffle(members);
            for (var i in members) {
                self.poll[`<@${members[i]}>`] = {
                    number: i,
                    response: UNKNOWN
                };
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
            let userId = `<@${user}>`;
            if (userId in self.poll) {
                if (self.poll[userId].response != response) {
                    if (!(self.poll[userId].response == UNKNOWN && response == NO)) {
                        self._teams = null;
                    }
                    self.poll[userId].response = response;
                }
                resolve(true);
            } else {
                // Add new user to poll
                self.poll[userId] = {
                    number: self.poll.length,
                    response: response
                };
                resolve(true);
            }
        });
    }

    result() {
        let result = [[], [], []]; // 0 - Unknown, 1 - Yes, 2 - No
        for (var user in this.poll) {
            result[this.poll[user].response].push(user);
        }
        return result;
    }

    async teams() {
        if (this._teams) {
            return this._teams;
        } else {
            let players = [];
            let headCount = 0;
            for (var userId in this.poll) {
                if (this.poll[userId].response == YES) {
                    players.splice(this.poll[userId].number, 0, userId);
                } else {
                    players.splice(this.poll[userId].number, 0, null);
                }
                headCount++;
            }
            if (headCount >= 4) {
                // Allocate teams by number given (order of players array)
                let teams = [[], []]; // 0 - Home, 1 - Away
                for (var i in players) {
                    if (players[i]) {
                        let t = i % 2;
                        if (teams[t].length > teams[t?HOME:AWAY].length) {
                            teams[t?HOME:AWAY].push(players[i]);
                        } else {
                            teams[t].push(players[i]);
                        }
                    }
                }
                this._teams = teams;
                return this._teams;
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
                        "text": `:+1: Sure!    \`${result[YES].length}\`\n${result[YES]}\n\n:-1: Nah    \`${result[NO].length}\`\n${result[NO]}\n\n:question: No answer    \`${result[UNKNOWN].length}\`\n${result[UNKNOWN]}`,
                        "fallback": "You cannot choose an option at this time",
                        "callback_id": "weekly_game",
                        "attachment_type": "default",
                        "actions": [
                            {
                                "name": "weekly_game_res",
                                "text": "Sure!",
                                "type": "button",
                                "value": YES
                            },
                            {
                                "name": "weekly_game_res",
                                "text": "Nah",
                                "type": "button",
                                "value": NO,
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
                            "text": `:house: Home    \`${teams[HOME].length}\`\n${teams[HOME]}\n\n:car: Away    \`${teams[AWAY].length}\`\n${teams[AWAY]}`
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
    web.channels.info(footballChannelId)
    .then(function (res) {
        myPoll.reset(res.channel.members).catch(console.error);
    })
    .catch(console.error);
    latestPollMessageTs = null;
    let nextTimeMs = await myBot.nextGameMs();
    console.log(`myPoll reset - next reset in ${nextTimeMs/1000} seconds`);
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

    myPoll = new GamePoll(footballChannelId);
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
                    sendMessage(message.channel, await myPoll.teamsMessage());
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
    addr: 8081,
    authtoken: ngrokToken,
    region: 'eu'
}, function (err, url) {
    if (err) {
        console.error(`Error loading ngrok: ${err}`);
    } else {
        web.chat.postEphemeral(footballChannelId, `New Request URL: ${url}/slack/action\nGo to https:/\/api.slack.com/apps/${appId}/interactive-messages to update the Request URL`, adminUserId);
        console.log(`New Request URL: ${url}/slack/action`);
    }
});
