require('dotenv').config();
const express = require('express');
const axios = require('axios');
const EmojiConvertor = require('emoji-js');
const path = require('path');
const { LRUCache } = require('lru-cache');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const { minify } = require('html-minifier-terser');
const ejs = require('ejs');

const { testGateway, getNotifications } = require('./gateway');
const { themes, getDefaultTheme } = require('./themes');
const { compressID, decompressID, compressToken, decompressToken } = require('./compress');
const stringFormatMiddleware = require('./format');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 }
});

const emoji = new EmojiConvertor();
emoji.replace_mode = 'unified';

const emojiImg = new EmojiConvertor();
emojiImg.replace_mode = 'img';
emojiImg.img_sets.joypixels = {
    path: 'https://cdn.jsdelivr.net/joypixels/assets/6.6/png/unicode/64/',
    sheet: '',
    mask: 1
};
emojiImg.img_set = 'joypixels';

const app = express();
const DEST_BASE = "https://discord.com/api/v9";

app.set('view engine', 'ejs');
app.set('views', './views');

app.use(express.static(path.join(__dirname, 'static')));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(stringFormatMiddleware);

// ID -> username mapping cache (used for parsing mentions)
const userCache = new LRUCache({ max: 10000 });
const channelNameCache = new LRUCache({ max: 10000 });
const channelGuildCache = new LRUCache({ max: 10000 });
const messageCache = new LRUCache({ max: 10000, ttl: 30 * 60 * 1000 });
const memberNickCache = new LRUCache({ max: 10000, ttl: 60 * 60 * 1000 });
const channelMembersHarvestCache = new LRUCache({ max: 500, ttl: 15 * 60 * 1000 });
const guildMembersHarvestCache = new LRUCache({ max: 500, ttl: 15 * 60 * 1000 });
const guildMembersCache = new LRUCache({ max: 200, ttl: 60 * 60 * 1000 });
const userRelationshipsCache = new LRUCache({ max: 100, ttl: 15 * 60 * 1000 });

function recordGuildMember(rawGuildId, id, username, globalName, nick) {
    if (!rawGuildId || !id) return;
    let map = guildMembersCache.get(rawGuildId);
    if (!map) {
        map = new Map();
        guildMembersCache.set(rawGuildId, map);
    }
    const displayName = (nick || null) ?? (globalName || null) ?? username ?? id;
    map.set(id, {
        id,
        username: username || displayName,
        globalName: globalName || null,
        nick: nick || null,
        displayName
    });
    if (nick) {
        memberNickCache.set(`${rawGuildId}:${id}`, nick);
    }
    userCache.set(id, displayName);
}

async function getGuildMemberNick(rawGuildId, rawUserId, headers) {
    if (!rawGuildId || !rawUserId) return null;
    const cacheKey = `${rawGuildId}:${rawUserId}`;
    if (memberNickCache.has(cacheKey)) {
        return memberNickCache.get(cacheKey);
    }
    try {
        const res = await axios.get(
            `${DEST_BASE}/guilds/${rawGuildId}/members/${rawUserId}`,
            { headers }
        );
        const nick = res.data?.nick || res.data?.user?.global_name || null;
        memberNickCache.set(cacheKey, nick);
        return nick;
    } catch (e) {
        if (e.response?.status === 404) {
            memberNickCache.set(cacheKey, null);
        }
        return null;
    }
}

function getRawUserIdFromToken(token) {
    if (!token || !token.trim().length) return null;
    try {
        let idPart = token.split('.')[0];
        if (idPart.length < 17) {
            return decompressID(idPart, 'user');
        } else {
            return atob(idPart);
        }
    } catch (e) {
        return null;
    }
}

function extractLinks(text) {
    if (!text) return [];
    const matches = text.match(/https?:\/\/[^\s<"'\(\)]+/g) || [];
    const cleaned = matches.map(url => url.replace(/[.,!?)]+$/, ''));
    return [...new Set(cleaned)];
}

function getIdTimestamp(res, id) {
    if (!id) return "N/A";

    const date = new Date(Number((BigInt(id) >> 22n) + 1420070400000n));
    date.setHours(date.getHours() + res.locals.settings.timeOffsetHours);
    date.setMinutes(date.getMinutes() + res.locals.settings.timeOffsetMinutes);

    const now = new Date();
    now.setHours(now.getHours() + res.locals.settings.timeOffsetHours);
    now.setMinutes(now.getMinutes() + res.locals.settings.timeOffsetMinutes);

    if (date.getDate() == now.getDate() && date.getMonth() == now.getMonth() && date.getFullYear() == now.getFullYear()) {
        // today -> show the time
        let period = '';

        if (res.locals.settings.use12hTime) {
            period = date.getHours() < 12 ? "A" : "P";

            // Convert hours to 12-hour format
            date.setHours(date.getHours() % 12);
            if (date.getHours() == 0) {
                date.setHours(12);
            }
        }

        let minutes = date.getMinutes();
        if (minutes < 10) minutes = '0' + minutes;

        return date.getHours() + ":" + minutes + period;
    } else {
        // not today -> show the date
        let day = date.getDate();
        if (day < 10) day = '0' + day;

        let month = date.getMonth() + 1;
        if (month < 10) month = '0' + month;

        return day + "/" + month;
    }
}

function normalizeStr(str, convertEmoji = false, res = null) {
    if (str === null || str === undefined) return "(err)";
    str = String(str);
    if (convertEmoji) str = parseMessageContentText(str, res);
    return str;
}

function normalizeStripEmoji(req, str, res = null) {
    res = res || req?.res;
    if (res?.locals?.theme?.stripEmoji) {
        const strConvEmoji = normalizeStr(str, true, res);
        if (str == strConvEmoji) return str;

        const strNoEmoji = strConvEmoji.replace(/:\w+:/g, '');
        if (strNoEmoji.length) return strNoEmoji;
        return strConvEmoji;
    }

    return normalizeStr(str, true, res);
}

function getError(e) {
    if (!e.message) return e.toString();

    if (e.message == "Request failed with status code 401") {
        return "Authentication failed. Make sure the token is valid and entered correctly."
    }
    if (e.message == "Request failed with status code 403") {
        return "Access denied. Make sure you have permission to access this channel."
    }
    if (e.message == "Request failed with status code 404") {
        return "The channel was not found."
    }
    if (e.message == "The string to be decoded is not correctly encoded.") {
        return "We've updated our ID encoding scheme. Please return to the Discord WAP front page and try again."
    }
    return e.message;
}

function parseMessageObject(req, res, msg, rawGuildId = null) {
    const result = {
        id: msg.id ? compressID(msg.id) : undefined,
        showAuthor: msg.showAuthor,
        avatar: msg.avatar,
        edited: msg.edited_timestamp
    }
    if (msg.author) {
        if (rawGuildId) {
            recordGuildMember(rawGuildId, msg.author.id, msg.author.username, msg.author.global_name, msg.member?.nick);
        }
        const author = (msg.member?.nick || null)
            ?? (rawGuildId ? memberNickCache.get(`${rawGuildId}:${msg.author.id}`) : null)
            ?? userCache.get(msg.author.id)
            ?? (msg.author.global_name || null)
            ?? msg.author.username;
        result.author = {
            id: msg.author.id ? compressID(msg.author.id) : undefined,
            name: normalizeStripEmoji(req, author, res),
        }
        result.authorLine = normalizeStripEmoji(req, author + " " + getIdTimestamp(res, msg.id), res);
        result.timestamp = getIdTimestamp(res, msg.id);  // separate timestamp for html version
    }
    if (rawGuildId && msg.mentions) {
        msg.mentions.forEach(m => {
            recordGuildMember(rawGuildId, m.id, m.username, m.global_name, m.member?.nick);
        });
    }
    if (msg.type >= 1 && msg.type <= 11) {
        result.isStatus = true;
        result.type = msg.type;
    }

    // Parse content 
    result.content = parseMessageContent(res, msg, false, rawGuildId);

    if (msg.referenced_message) {
        let content = parseMessageContent(res, msg.referenced_message, true, rawGuildId);

        // Replace newlines with spaces (reply is shown as one line)
        content = content.replace(/\r\n|\r|\n/gm, "  ");

        const limit = res?.locals?.theme?.replyPreviewLength ?? 50;

        if (content && content.length > limit) {
            content = content.slice(0, limit - 3).trim() + '...';
        }
        const refAuthor = (msg.referenced_message.member?.nick || null)
            ?? (rawGuildId ? memberNickCache.get(`${rawGuildId}:${msg.referenced_message.author?.id}`) : null)
            ?? userCache.get(msg.referenced_message.author?.id)
            ?? (msg.referenced_message.author?.global_name || null)
            ?? msg.referenced_message.author?.username
            ?? "Unknown";
        if (rawGuildId && msg.referenced_message.author?.id) {
            recordGuildMember(rawGuildId, msg.referenced_message.author.id, msg.referenced_message.author.username, msg.referenced_message.author.global_name, msg.referenced_message.member?.nick);
        }
        result.referenced_message = {
            author: {
                name: normalizeStripEmoji(req, refAuthor, res),
                id: msg.referenced_message.author?.id ? compressID(msg.referenced_message.author.id) : undefined,
            },
            content
        }
    }

    if (msg.attachments) {
        result.attachments = msg.attachments.map(att => {
            const isImage = Boolean(att.content_type?.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(att.filename || ''));
            let url;
            if (isImage) {
                let width = att.width;
                let height = att.height;
                if (width > 1000 || height > 1000) {
                    const ratio = Math.max(att.width, att.height) / 1000;
                    width = Math.round(width / ratio);
                    height = Math.round(height / ratio);
                }
                if (att.proxy_url) {
                    const proxyHttp = att.proxy_url.replace(/^https:\/\//, 'http://');
                    const sep = proxyHttp.includes('?') ? '&' : '?';
                    url = (width && height) ? `${proxyHttp}${sep}width=${width}&height=${height}` : proxyHttp;
                } else if (process.env.CDN_PROXY) {
                    url = att.url.replace("https://cdn.discordapp.com", process.env.CDN_PROXY);
                } else {
                    url = att.url;
                }
            }
            else if (process.env.CDN_PROXY) {
                url = att.url.replace("https://cdn.discordapp.com", process.env.CDN_PROXY);
            }
            else {
                url = att.url;
            }

            return {
                id: att.id,
                filename: att.filename,
                url,
                isImage,
                size: att.size,
                contentType: att.content_type
            };
        });
    }

    if (msg.embeds) {
        result.embeds = msg.embeds
            .filter(emb => emb.type === 'rich')
            .map(emb => {
                let colorHex = (emb.color !== undefined && emb.color !== null)
                    ? '#' + emb.color.toString(16).padStart(6, '0')
                    : '#4f545c';
                let title = emb.title ? parseMessageContentText(emb.title, res) : null;
                let description = emb.description ? parseMessageContentText(emb.description, res) : null;
                let authorName = emb.author?.name ? parseMessageContentText(emb.author.name, res) : null;
                let footerText = emb.footer?.text ? parseMessageContentText(emb.footer.text, res) : null;
                let fields = emb.fields?.map(f => ({
                    name: parseMessageContentText(f.name, res),
                    value: parseMessageContentText(f.value, res)
                })) || [];

                return {
                    title,
                    description,
                    authorName,
                    footerText,
                    fields,
                    color: colorHex
                };
            });
        if (!result.embeds.length) {
            delete result.embeds;
        }
    }

    if (msg.reactions && msg.reactions.length) {
        result.reactions = msg.reactions.map(r => {
            const isCustom = Boolean(r.emoji?.id);
            const emojiApiStr = isCustom ? `${r.emoji.name}:${r.emoji.id}` : r.emoji.name;
            let emojiDisplay = r.emoji?.name || '';
            if (isCustom) {
                let emojiUrl = `https://cdn.discordapp.com/emojis/${r.emoji.id}.png?size=32`;
                if (process.env.CDN_PROXY) {
                    emojiUrl = emojiUrl.replace("https://cdn.discordapp.com", process.env.CDN_PROXY);
                }
                if (res?.locals?.format === 'wml') {
                    emojiDisplay = `:${r.emoji.name}:`;
                } else {
                    emojiDisplay = `<img src="${emojiUrl}" class="emoji" alt=":${r.emoji.name}:" width="16" height="16" />`;
                }
            } else {
                emojiDisplay = parseMessageContentText(emojiDisplay, res);
            }

            return {
                emojiName: r.emoji?.name,
                emojiId: r.emoji?.id,
                apiStr: encodeURIComponent(emojiApiStr),
                rawApiStr: emojiApiStr,
                display: emojiDisplay,
                count: r.count,
                me: Boolean(r.me)
            };
        });
    }

    return result;
}

function parseMessageContent(res, msg, singleLine = false, rawGuildId = null) {
    const target = (msg.mentions?.[0]?.member?.nick || null)
        ?? (rawGuildId ? memberNickCache.get(`${rawGuildId}:${msg.mentions?.[0]?.id}`) : null)
        ?? userCache.get(msg.mentions?.[0]?.id)
        ?? (msg.mentions?.[0]?.global_name || null)
        ?? msg.mentions?.[0]?.username;
    switch (msg.type) {
        case 1: return `added ${target} to the group`;
        case 2: return `removed ${target} from the group`;
        case 3: return `started a call`;
        case 4: return `changed the group name`;
        case 5: return `changed the group icon`;
        case 6: return `pinned a message`;
        case 7: return `joined the server`;
        case 8: return `boosted the server`;
        case 9: return `boosted the server to level 1`;
        case 10: return `boosted the server to level 2`;
        case 11: return `boosted the server to level 3`;
        default: return parseMessageContentNonStatus(res, msg, singleLine);
    }
}

function parseMessageContentNonStatus(res, msg, singleLine) {
    let result = "";

    // Content from forwarded message
    if (msg.message_snapshots) {
        result = parseMessageContent(res, msg.message_snapshots[0].message);
    }
    // Normal message content
    else if (msg.content) {
        result = parseMessageContentText(msg.content, res);
    }

    if (msg.attachments?.length && !res.locals.theme.showAttachments) {
        msg.attachments.forEach(att => {
            if (result.length) result += "\n";
            result += `(file: ${parseMessageContentText(att.filename, res)})`;
        })
    }
    if (msg.sticker_items?.length) {
        if (result.length) result += "\n";
        result += `(sticker: ${parseMessageContentText(msg.sticker_items[0].name, res)})`;
    }
    if (msg.embeds?.length) {
        msg.embeds.forEach(emb => {
            if (emb.type === 'rich') return;
            if (!emb.title) return;
            if (result.length) result += "\n";
            result += `(embed: ${parseMessageContentText(emb.title, res)})`;
        })
    }
    if (result == '' && !msg.attachments && !msg.embeds?.some(e => e.type === 'rich')) return "(unsupported message)";

    // iOS keyboard replaces apostrophes with a unicode character that shows up as missing character on old phones
    result = result.replace(/’/g, "'");

    if (singleLine) result = result.replace(/\n/g, " ");
    return result;
}

function parseMessageContentText(content, res = null) {
    if (!content) return content;
    let result = content
        // try to convert <@12345...> format into @username
        .replace(/<@(\d{15,})>/gm, (mention, id) => {
            if (userCache.has(id)) return `@${userCache.get(id)}`;
            // return mention with shortened ID
            return `@(${compressID(id)})`;
        })
        .replace(/<#(\d{15,})>/gm, (mention, id) => {
            if (channelNameCache.has(id)) return channelNameCache.get(id);
            // return mention with shortened ID
            return `#(${compressID(id)})`;
        })
        .replace(/<:\w+:(\d+)>/gm, (emoji) => emoji.split(':')[1])
        // replace emojis with readable names (e.g. :cat:), and convert some common smileys into emojis
        // because emoji-js supports more smileys than old phones do
        .replace(/:\)/g, ":slight_smile:")
        .replace(/:\(/g, ":slight_frown:")
        .replace(/:3/g, ":cat:")
        .replace(/:D/g, ":smiley:")
        .replace(/'-\)/g, ":sweat_smile:")
        .replace(/;-\)/g, ":wink:")
        .replace(/;-\(/g, ":sob:")
        .replace(/xD/g, ":laughing:")
        .replace(/XD/g, ":laughing:")
        .replace(/:-P/g, ":stuck_out_tongue:")
        .replace(/:-p/g, ":stuck_out_tongue:")
        .replace(/:P/g, ":stuck_out_tongue:")
        .replace(/:p/g, ":stuck_out_tongue:")
        .replace(/;-P/g, ":stuck_out_tongue_winking_eye:")
        .replace(/;-p/g, ":stuck_out_tongue_winking_eye:")
        .replace(/;P/g, ":stuck_out_tongue_winking_eye:")
        .replace(/;p/g, ":stuck_out_tongue_winking_eye:")
        .replace(/<3/g, ":heart:");

    if (res?.locals?.settings?.convertEmojisToImages) {
        result = emojiImg.replace_unified(emojiImg.replace_colons(result));
    } else {
        result = emoji.replace_unified(result);
    }
    return result;
}

function makeGetTokenMiddleware(isOptional) {
    return (req, res, next) => {
        res.locals.token = req.query?.t ?? req.query?.token ?? req.body?.t ?? req.body?.token ?? req.cookies?.dwtoken;

        if (!res.locals.token) {
            if (isOptional) {
                res.locals.token = "";
                res.locals.compressedToken = "";
                res.locals.tokenParam = "";
                next();
                return;
            } else {
                throw new Error("Your request does not contain a token. Please return to the Discord WAP front page and try again.");
            }
        }

        if (process.env.PASSWORD && process.env.PASSWORD_TOKEN && res.locals.token == process.env.PASSWORD) {
            res.locals.token = process.env.PASSWORD_TOKEN;
        }

        res.locals.userID = res.locals.token.split('.')[0];

        const ua = (req.headers['user-agent'] ?? '').toLowerCase();
        const isOperaMini = ua.includes('opera mini') || ua.includes('operamini');

        if (req.query.s0) {
            res.locals.token = res.locals.token.split('.').slice(0, 3).join('.')
                + '.' + req.query.s0
                + '.' + req.query.s1
                + '.' + req.query.s2
                + '.' + req.query.s3
                + '.' + req.query.s4
                + '.' + req.query.s5
                + '.' + req.query.s6
                + '.' + req.query.s7
                + '.' + req.query.s8
                + '.' + (req.query.s9 ?? (isOperaMini ? '1' : '0'));
        }
        const settingsArr = res.locals.token.split('.').slice(3);

        const themeIndex = Number(settingsArr[7]);

        if (themeIndex >= 0 && themeIndex < themes.length) {
            res.locals.theme = themes[themeIndex];
        }

        res.locals.format = (res.locals.theme.id == 'wml') ? 'wml' : 'html';

        let messageLoadCount = Number(settingsArr[0]) || res.locals.theme.messageCountDefault;
        if (messageLoadCount > 100) messageLoadCount = 100;
        else if (messageLoadCount < 1) messageLoadCount = 1;

        let timeOffsetHours = Number(settingsArr[2]) || 0;
        let timeOffsetMinutes = Number(settingsArr[3]) || 0;
        if (timeOffsetHours < -14) timeOffsetHours = -14;
        if (timeOffsetHours > 14) timeOffsetHours = 14;
        if (![0, 15, 30, 45].includes(timeOffsetMinutes)) timeOffsetMinutes = 0;

        res.locals.settings = {
            messageLoadCount,
            channelListLayout: ['default', 'recent', 'collapsed'][(Number(settingsArr[1]) || 0)],
            timeOffsetHours,
            timeOffsetMinutes,
            use12hTime: (Number(settingsArr[4]) || 0) != 0,
            limitTextBoxSize: (Number(settingsArr[5]) || 0) != 0,
            reverseChat: (Number(settingsArr[6] ?? res.locals.theme.messagesOnBottomDefault)) != 0,
            useAnyAscii: (Number(settingsArr[8] ?? (res.locals.format == 'wml'))) != 0,
            convertEmojisToImages: (Number(settingsArr[9] ?? (isOperaMini ? 1 : 0))) != 0,
        }

        res.locals.authToken = decompressToken(res.locals.token).split('.').slice(0, 3).join('.');

        res.locals.headers = {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
            "Accept": "*/*",
            "Accept-Language": "en-US,en;q=0.5",
            "Authorization": res.locals.authToken,
            "X-Discord-Locale": "en-GB",
            "X-Debug-Options": "bugReporterEnabled",
            "Sec-Fetch-Dest": "empty",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "same-origin"
        };
        if (req.cookies?.dwtoken != res.locals.token) {
            res.cookie('dwtoken', res.locals.token, { maxAge: 1000 * 60 * 60 * 24 * 30 });
        }
        res.locals.compressedToken = compressToken(res.locals.token);
        res.locals.tokenParam = '?t=' + res.locals.compressedToken;
        next();
    }
}

const getToken = makeGetTokenMiddleware(false);
const getTokenOptional = makeGetTokenMiddleware(true);

async function fetchDMs(req, res) {
    const dmsGet = await axios.get(
        `${DEST_BASE}/users/@me/channels`,
        { headers: res.locals.headers }
    )
    // Sort by latest first
    dmsGet.data.sort((a, b) => {
        const a_id = BigInt(a.last_message_id ?? 0);
        const b_id = BigInt(b.last_message_id ?? 0);
        return (a_id < b_id ? 1 : a_id > b_id ? -1 : 0)
    });

    return dmsGet.data
        .filter(ch => ch.type == 1 || ch.type == 3)
        .slice(0, (res.locals.format == 'wml') ? 15 : 20)
        .map(ch => {
            const result = {
                id: compressID(ch.id),
            }

            // Add group name for group DMs, recipient name for normal DMs
            let cacheName;
            result.isGroup = (ch.type == 3);
            if (result.isGroup) {
                result.name = ch.name ?? ch.recipients.map(rec => rec.global_name ?? rec.username).join(", ");
                cacheName = result.name;
            } else {
                result.name = ch.recipients[0].global_name ?? ch.recipients[0].username;
                cacheName = '@' + result.name;
            }

            // populate cache
            channelNameCache.set(ch.id, cacheName);

            result.name = normalizeStripEmoji(req, result.name);
            return result;
        })
}

app.use((req, res, next) => {
    res.locals.format = req.accepts("html") ? "html" : "wml";
    res.locals.theme = getDefaultTheme(req, res);
    next();
})

async function render(res, viewName, viewVars = {}) {
    if (res.locals.format == "wml") res.set("Content-Type", "text/vnd.wap.wml");

    const rendered = await ejs.renderFile(`views/${res.locals.theme.viewsDir}/${viewName}.ejs`, {
        ...res.locals,
        settings: res.locals.settings,
        ...viewVars
    })

    // Don't minify for WML, causes WMLC compilation error
    const minified = (res.locals.format == "wml") ? rendered :
        await minify(rendered, {
            collapseWhitespace: true,
            removeComments: true,
            minifyCSS: true,
            minifyJS: true
        });

    res.send(minified);
}

function getGuildPath(guildID) {
    return (guildID && guildID !== '@me') ? `/g/${guildID}/c` : `/d`;
}

app.get("/", (req, res) => {
    render(res, "index", {
        userAgent: req.headers['user-agent']
    });
});

app.get("/about", getTokenOptional, (req, res) => {
    render(res, "about", {
        userAgent: req.headers['user-agent']
    });
})

// Main menu (including DMs in WML version)
app.get("/main", getToken, async (req, res) => {
    render(res, "main", {
        dms: (res.locals.format == 'wml') && await fetchDMs(req, res),
    });
})

// Direct message list (separate page for HTML version)
app.get("/d", getToken, async (req, res) => {
    res.locals.dms = await fetchDMs(req, res);
    render(res, "dms");
})

// Inbox (mentions and received DMs)
app.get("/i", getToken, async (req, res) => {
    let notifications = await getNotifications(res.locals.authToken);

    notifications.sort((a, b) => {
        // DMs first
        if (!a.guildName && b.guildName) return -1;
        if (!b.guildName && a.guildName) return 1;

        // otherwise sort by channel name alphabetically
        if (a.channelName < b.channelName) return -1;
        if (b.channelName < a.channelName) return 1;
        return 0;
    });

    notifications = notifications.map(n => ({
        ...n,
        path: n.guildName ?
            `/g/${compressID(n.guildID)}/c/${compressID(n.channelID)}` :
            `/d/${compressID(n.channelID)}`
    }))

    render(res, "inbox", {
        notifications,
        compressID
    });
})

const guildCache = new LRUCache({ max: 500, ttl: 60 * 60 * 1000, updateAgeOnGet: false });

async function getGuilds(req, res) {
    if (guildCache.has(res.locals.userID)) {
        return guildCache.get(res.locals.userID);
    } else {
        const guildsGet = await axios.get(
            `${DEST_BASE}/users/@me/guilds`,
            { headers: res.locals.headers }
        );

        let guildPositions = [];
        try {
            // Get user settings which contains the order of servers
            const userSettingsGet = await axios.get(
                `${DEST_BASE}/users/@me/settings`,
                { headers: res.locals.headers }
            );
            guildPositions = userSettingsGet.data?.guild_positions ||
                userSettingsGet.data?.guild_folders?.flatMap(f => f.guild_ids || []) ||
                [];
        } catch (e) {
            console.warn("Could not fetch user guild positions:", e?.message);
        }

        // Sort guilds by the order specified in user settings
        const guilds = (guildsGet.data || []).map(g => {
            const index = Array.isArray(guildPositions) ? guildPositions.indexOf(g.id) : -1;
            return {
                id: compressID(g.id),
                name: normalizeStripEmoji(req, g.name),
                position: (index !== -1) ? index : 999
            };
        });
        guilds.sort((a, b) => a.position - b.position);

        guildCache.set(res.locals.userID, guilds);
        return guilds;
    }
}

async function getGuildName(req, res, guildID) {
    if (!guildID) return "Direct Messages";

    const decompressedID = decompressID(guildID, "server");

    // Fetch from cache or API
    const guilds = await getGuilds(req, res);
    const guild = guilds.find(g => g.id == guildID);
    if (!guild) return "(unknown)";
    return guild.name;
}

// Server list
app.get("/g", getToken, async (req, res) => {
    const guilds = await getGuilds(req, res);

    const pageSize = res.locals.theme.guildsPageSize;
    const pageBegin = Number(req.query.p ?? 0);
    const pageEnd = pageBegin + pageSize;

    res.locals.hasMoreAbove = (pageBegin != 0);
    res.locals.hasMoreBelow = (guilds.length > pageEnd);
    res.locals.nextPage = pageEnd;
    res.locals.previousPage = Math.max(0, pageBegin - pageSize);
    res.locals.guilds = guilds.slice(pageBegin, pageEnd);

    render(res, "guilds");
})

const channelCache = new LRUCache({ max: 400, ttl: 10 * 60 * 1000, updateAgeOnGet: false });

async function getChannels(req, res, guildID, useCache) {
    if (!guildID) guildID = res.locals.userID;

    if (useCache && channelCache.has(guildID)) {
        return channelCache.get(guildID);
    } else {
        const channels = await axios.get(
            `${DEST_BASE}/guilds/${decompressID(guildID, 'server')}/channels`,
            { headers: res.locals.headers }
        )
        if (useCache) channelCache.set(guildID, channels.data);

        // Populate channel name cache and guild mapping cache
        const decompressedGuildId = decompressID(guildID, 'server');
        channels.data.forEach(ch => {
            channelNameCache.set(ch.id, '#' + ch.name);
            channelGuildCache.set(ch.id, decompressedGuildId);
        })
        return channels.data;
    }
}

async function getChannelName(req, res, guildID, channelID) {
    const decompressedID = decompressID(channelID, "channel");

    let cachedName = channelNameCache.get(decompressedID);
    if (cachedName) return cachedName;

    if (guildID) {
        const channels = await getChannels(req, res, guildID, true);
        const channel = channels.find(c => c.id == decompressedID);
        if (!channel) return "(unknown)";
        return '#' + channel.name;
    } else {
        const dmChannels = await fetchDMs(req, res);
        cachedName = channelNameCache.get(decompressedID);
        if (!cachedName) return "(unknown)";
        return cachedName;
    }
}

// Channel list of a server
app.get(["/g/:guildid", "/g/:guildid/c"], getToken, async (req, res) => {
    const guildID = req.params.guildid;
    const guildName = await getGuildName(req, res, guildID);

    // Channel list cache can be used if last message IDs are not relevant ("Recent channels first" disabled and using HTML version)
    const useCache = (res.locals.settings.channelListLayout != 'recent' && res.locals.format == 'html');

    const channelsGet = await getChannels(req, res, guildID, useCache);

    // Due to page length limitations, limit the amount of channels to be shown:

    // Sort channels by most recently used
    const allChannels = channelsGet.filter(ch => ch.type == 0 || ch.type == 5);
    allChannels.sort((a, b) => {
        const a_id = BigInt(a.last_message_id ?? 0);
        const b_id = BigInt(b.last_message_id ?? 0);
        return (a_id < b_id ? 1 : a_id > b_id ? -1 : 0)
    });

    let channels;

    if (res.locals.settings.channelListLayout == 'recent') {
        // "Recent channels first" option enabled: show up to 15 (WML) or 30 (HTML) channels in order of most recent message
        channels = allChannels
            .slice(0, (res.locals.format == 'wml') ? 15 : 30)
            .map(ch => ({
                id: compressID(ch.id),
                name: normalizeStripEmoji(req, ch.name),
                label: normalizeStripEmoji(req, getIdTimestamp(res, ch.last_message_id) + ' ' + ch.name),
                timestamp: getIdTimestamp(res, ch.last_message_id),
                parent_id: ch.parent_id
            }))
    } else {
        // "Recent channels first" disabled: show channels in their original order
        // (still only show 15 most recently used channels in WML when not in collapsed mode)
        if (res.locals.format == 'wml' && res.locals.settings.channelListLayout != 'collapsed') {
            const recentChannelIDs = allChannels
                .slice(0, 15)
                .map(ch => ch.id);

            // Also, channels with certain names will always be shown, because those are channels that people might often want to visit.
            const whitelistedChannelIDs = allChannels
                .filter(ch => /^(general|phones|off\S*topic|discord-j2me-wap)$/g.test(ch.name))
                .map(ch => ch.id);

            const shownChannelIDs = [...new Set([...recentChannelIDs, ...whitelistedChannelIDs])]

            channels = allChannels.filter(ch => shownChannelIDs.includes(ch.id));
        } else {
            channels = allChannels;
        }

        channels = channels
            .sort((a, b) => a.position - b.position)
            .map(ch => ({
                id: compressID(ch.id),
                name: normalizeStripEmoji(req, ch.name),
                label: normalizeStripEmoji(req, '#' + ch.name),
                parent_id: ch.parent_id
            }))
    }

    const allChannelCategories = channelsGet.filter(ch => ch.type == 4)
        .sort((a, b) => a.position - b.position)
        .map(ch => ({
            ...ch,
            name: normalizeStripEmoji(req, ch.name),
            children: []
        }));

    // default category for channels that are not in any category (shown at the top both on official clients and on wap)
    const defaultCategory = {
        name: guildName,
        children: []
    };
    allChannelCategories.unshift(defaultCategory);

    channels.forEach(ch => {
        const cat = allChannelCategories.find(cat => cat.id == ch.parent_id);
        if (cat) {
            cat.children.push(ch);
        } else {
            defaultCategory.children.push(ch);
        }
    })

    const channelCategories = allChannelCategories.filter(ch => ch.children.length);

    render(res, "channels", {
        gname: guildName,
        gid: guildID,
        channels,
        channelCategories
    });
})

// ported from discord j2me
function shouldShowAuthor(msg, above, clusterStart) {
    if (!above) return true;
    if (msg.referenced_message) return true;
    if (above.author?.id != msg.author?.id) return true;
    if (msg.attachments && !msg.content) return true;
    if (msg.isStatus || above.isStatus) return true;

    return (BigInt(msg.id) >> 22n) - (BigInt(clusterStart) >> 22n) > BigInt(7 * 60 * 1000);
}

// Get channel messages
app.get(["/d/:channelid", "/g/:guildid/c/:channelid", "/wap/ch"], getToken, async (req, res) => {
    const guildID = req.params.guildid ?? (req.query.gid && req.query.gid !== '@me' ? req.query.gid : undefined);
    const channelID = req.params.channelid ?? req.query?.id ?? req.body?.id;
    const guildName = await getGuildName(req, res, guildID);
    const guildPath = getGuildPath(guildID);
    const channelName = await getChannelName(req, res, guildID, channelID);

    const rawChannelId = decompressID(channelID, 'channel');
    if (guildID) {
        channelGuildCache.set(rawChannelId, decompressID(guildID, 'server'));
    }

    let proxyUrl = `${DEST_BASE}/channels/${rawChannelId}/messages`;
    let queryParam = [`limit=${res.locals.settings.messageLoadCount}`];
    if (req.query.b) queryParam.push(`before=${decompressID(req.query.b, 'message')}`);
    if (req.query.a) queryParam.push(`after=${decompressID(req.query.a, 'message')}`);
    proxyUrl += '?' + queryParam.join('&');

    const messagesGet = (await axios.get(proxyUrl, { headers: res.locals.headers })).data;

    // Fetch server-specific nicknames if in a guild
    const rawGuildId = (guildID && guildID !== '@me') ? decompressID(guildID, 'server') : (channelGuildCache.get(rawChannelId) || null);
    if (rawGuildId) {
        // First populate memberNickCache from any messages or mentions that already include member.nick
        messagesGet.forEach(msg => {
            if (msg.author?.id && msg.member?.nick) {
                memberNickCache.set(`${rawGuildId}:${msg.author.id}`, msg.member.nick);
            }
            if (msg.mentions) {
                msg.mentions.forEach(m => {
                    if (m.id && m.member?.nick) {
                        memberNickCache.set(`${rawGuildId}:${m.id}`, m.member.nick);
                    }
                });
            }
        });

        const userIds = new Set();
        messagesGet.forEach(msg => {
            if (msg.author?.id) userIds.add(msg.author.id);
            if (msg.referenced_message?.author?.id) userIds.add(msg.referenced_message.author.id);
            if (msg.mentions) msg.mentions.forEach(m => userIds.add(m.id));
        });

        const uncachedIds = [...userIds].filter(id => !memberNickCache.has(`${rawGuildId}:${id}`));
        if (uncachedIds.length > 0) {
            await Promise.all(uncachedIds.map(id => getGuildMemberNick(rawGuildId, id, res.locals.headers)));
        }

        messagesGet.forEach(msg => {
            if (msg.author?.id) {
                const nick = memberNickCache.get(`${rawGuildId}:${msg.author.id}`);
                if (nick) {
                    msg.member = { ...msg.member, nick };
                }
            }
            if (msg.referenced_message?.author?.id) {
                const refNick = memberNickCache.get(`${rawGuildId}:${msg.referenced_message.author.id}`);
                if (refNick) {
                    msg.referenced_message.member = { ...msg.referenced_message.member, nick: refNick };
                }
            }
            if (msg.mentions) {
                msg.mentions.forEach(m => {
                    const mNick = memberNickCache.get(`${rawGuildId}:${m.id}`);
                    if (mNick) {
                        m.member = { ...m.member, nick: mNick };
                    }
                });
            }
        });
    }

    // Populate username and message cache
    const rawUserId = getRawUserIdFromToken(res.locals.token);
    messagesGet.forEach(msg => {
        const authorDisplayName = (msg.member?.nick || null)
            ?? (rawGuildId ? memberNickCache.get(`${rawGuildId}:${msg.author?.id}`) : null)
            ?? (msg.author?.global_name || null)
            ?? msg.author?.username;
        if (msg.author?.id) {
            userCache.set(msg.author.id, authorDisplayName);
            if (rawGuildId) {
                recordGuildMember(rawGuildId, msg.author.id, msg.author.username, msg.author.global_name, msg.member?.nick);
            }
        }
        if (msg.mentions) {
            msg.mentions.forEach(m => {
                const mentionName = (m.member?.nick || null)
                    ?? (rawGuildId ? memberNickCache.get(`${rawGuildId}:${m.id}`) : null)
                    ?? (m.global_name || null)
                    ?? m.username;
                if (m.id) {
                    userCache.set(m.id, mentionName);
                    if (rawGuildId) {
                        recordGuildMember(rawGuildId, m.id, m.username, m.global_name, m.member?.nick);
                    }
                }
            });
        }
        if (rawGuildId && msg.referenced_message?.author?.id) {
            recordGuildMember(rawGuildId, msg.referenced_message.author.id, msg.referenced_message.author.username, msg.referenced_message.author.global_name, msg.referenced_message.member?.nick);
        }
        const compressedId = compressID(msg.id);
        const isOwn = Boolean(msg.author && (msg.author.id === rawUserId || compressID(msg.author.id) === res.locals.userID));
        let rawContent = msg.content || "";
        if (!rawContent && msg.embeds?.length) {
            const rich = msg.embeds.find(e => e.type === 'rich');
            if (rich) {
                rawContent = [rich.title, rich.description].filter(Boolean).join("\n");
            }
        }
        let parsedContent = parseMessageContent(res, msg, false, rawGuildId);
        if ((!parsedContent || parsedContent === "(unsupported message)") && msg.embeds?.length) {
            const rich = msg.embeds.find(e => e.type === 'rich');
            if (rich) {
                parsedContent = [rich.title, rich.description].filter(Boolean).map(t => parseMessageContentText(t, res)).join("\n");
            }
        }
        const parsedMsg = parseMessageObject(req, res, msg, rawGuildId);
        messageCache.set(compressedId, {
            id: compressedId,
            rawId: msg.id,
            authorName: authorDisplayName,
            authorId: msg.author?.id,
            isOwn,
            content: parsedContent,
            rawContent: rawContent,
            links: extractLinks(rawContent),
            attachments: parsedMsg.attachments || [],
            reactions: msg.reactions || []
        });
    });

    // Message ID that should be marked as read
    // (don't mark as read if reading an older page of messages)
    const markReadID = !req.query.p && messagesGet.length && messagesGet[0].id;

    // See which messages the author line and profile pic should be shown for
    if (res.locals.settings.reverseChat && res.locals.format == 'html') {
        messagesGet.reverse();
    }
    let clusterStart = 0;
    let above = null;

    messagesGet.forEach(m => {
        m.showAuthor = shouldShowAuthor(m, above, clusterStart);
        if (m.showAuthor) {
            clusterStart = m.id;

            if (m.author?.id && m.author?.avatar) {
                m.avatar = `http://media.discordapp.net/avatars/${m.author.id}/${m.author.avatar}.png?size=16`
            }
        }
        above = m;
    })

    const messages = messagesGet.map(m => parseMessageObject(req, res, m, rawGuildId));

    render(res, "channel", {
        page: req.query.p ?? 0,
        messages,
        textBoxSize: res.locals.settings.limitTextBoxSize ? 200 : 2000,
        id: channelID,
        cname: channelName,
        gid: guildID,
        gname: guildName,
        gpath: guildPath,
    });

    // Mark latest message as read
    if (markReadID) {
        axios.post(
            `${DEST_BASE}/channels/${rawChannelId}/messages/${markReadID}/ack`,
            { token: null },
            { headers: res.locals.headers }
        )
            .catch(e => {
                console.log(e);
            })
    }
})

async function searchMembers(req, res, rawGuildId, rawChannelId, query = "") {
    const q = (query || "").trim().toLowerCase();
    const results = new Map();

    // Check if channel belongs to a guild if rawGuildId is not provided
    if (!rawGuildId && rawChannelId) {
        if (channelGuildCache.has(rawChannelId)) {
            rawGuildId = channelGuildCache.get(rawChannelId);
        } else {
            try {
                const chRes = await axios.get(
                    `${DEST_BASE}/channels/${rawChannelId}`,
                    { headers: res.locals.headers }
                );
                if (chRes.data?.guild_id) {
                    rawGuildId = chRes.data.guild_id;
                    channelGuildCache.set(rawChannelId, rawGuildId);
                }
            } catch (e) {}
        }
    }

    function addMember(id, username, globalName, nick) {
        if (!id) return;
        const displayName = (nick || null) ?? (globalName || null) ?? username ?? id;
        results.set(id, {
            id,
            username: username || displayName,
            globalName: globalName || null,
            nick: nick || null,
            displayName
        });
        if (rawGuildId) {
            recordGuildMember(rawGuildId, id, username, globalName, nick);
        }
        userCache.set(id, displayName);
    }

    if (rawGuildId) {
        // --- GUILD MODE: Only include verified members of this specific guild ---

        // 1. If query is a numeric ID (15-20 digits), try direct member fetch in this guild
        if (/^\d{15,20}$/.test(q)) {
            try {
                const memRes = await axios.get(
                    `${DEST_BASE}/guilds/${rawGuildId}/members/${q}`,
                    { headers: res.locals.headers }
                );
                if (memRes.data) {
                    const u = memRes.data.user || {};
                    addMember(u.id || q, u.username, u.global_name, memRes.data.nick);
                }
            } catch (e) {}
        }

        // 2. Try Discord Guild Members Search & Member List APIs
        if (q.length > 0) {
            try {
                const searchRes = await axios.get(
                    `${DEST_BASE}/guilds/${rawGuildId}/members/search?query=${encodeURIComponent(query.trim())}&limit=100`,
                    { headers: res.locals.headers }
                );
                if (Array.isArray(searchRes.data)) {
                    searchRes.data.forEach(m => {
                        if (m?.user?.id) {
                            addMember(m.user.id, m.user.username, m.user.global_name, m.nick);
                        }
                    });
                }
            } catch (e) {}
        }

        if (!guildMembersHarvestCache.has(rawGuildId)) {
            try {
                const membersRes = await axios.get(
                    `${DEST_BASE}/guilds/${rawGuildId}/members?limit=1000`,
                    { headers: res.locals.headers }
                );
                if (Array.isArray(membersRes.data)) {
                    membersRes.data.forEach(m => {
                        if (m?.user?.id) {
                            addMember(m.user.id, m.user.username, m.user.global_name, m.nick);
                        }
                    });
                    guildMembersHarvestCache.set(rawGuildId, true);
                }
            } catch (e) {}
        }

        // 3. Harvest channel messages (up to 100 recent messages) in this channel
        if (rawChannelId && !channelMembersHarvestCache.has(rawChannelId)) {
            try {
                const msgsRes = await axios.get(
                    `${DEST_BASE}/channels/${rawChannelId}/messages?limit=100`,
                    { headers: res.locals.headers }
                );
                if (Array.isArray(msgsRes.data)) {
                    msgsRes.data.forEach(msg => {
                        if (msg.author?.id) {
                            addMember(msg.author.id, msg.author.username, msg.author.global_name, msg.member?.nick);
                        }
                        if (msg.referenced_message?.author?.id) {
                            addMember(msg.referenced_message.author.id, msg.referenced_message.author.username, msg.referenced_message.author.global_name, msg.referenced_message.member?.nick);
                        }
                        if (msg.mentions) {
                            msg.mentions.forEach(m => {
                                addMember(m.id, m.username, m.global_name, m.member?.nick);
                            });
                        }
                    });
                    channelMembersHarvestCache.set(rawChannelId, true);
                }
            } catch (e) {}
        }

        // 4. Include members previously cached for this specific guild
        const cachedGuildMembers = guildMembersCache.get(rawGuildId);
        if (cachedGuildMembers) {
            for (const [id, m] of cachedGuildMembers.entries()) {
                if (!results.has(id)) {
                    results.set(id, m);
                }
            }
        }
    } else {
        // --- DM / NON-GUILD MODE: Search DM recipients, channel messages, friends, and cache ---

        // 1. If query is a numeric ID (15-20 digits), try direct user fetch
        if (/^\d{15,20}$/.test(q)) {
            try {
                const userRes = await axios.get(
                    `${DEST_BASE}/users/${q}`,
                    { headers: res.locals.headers }
                );
                if (userRes.data) {
                    addMember(userRes.data.id, userRes.data.username, userRes.data.global_name, null);
                }
            } catch (e) {}
        }

        // 2. Fetch DM / Group DM recipients
        if (rawChannelId) {
            try {
                const chRes = await axios.get(
                    `${DEST_BASE}/channels/${rawChannelId}`,
                    { headers: res.locals.headers }
                );
                if (chRes.data?.recipients) {
                    chRes.data.recipients.forEach(u => {
                        addMember(u.id, u.username, u.global_name, null);
                    });
                }
            } catch (e) {}
        }

        // 3. Harvest channel messages (up to 100 recent messages)
        if (rawChannelId && !channelMembersHarvestCache.has(rawChannelId)) {
            try {
                const msgsRes = await axios.get(
                    `${DEST_BASE}/channels/${rawChannelId}/messages?limit=100`,
                    { headers: res.locals.headers }
                );
                if (Array.isArray(msgsRes.data)) {
                    msgsRes.data.forEach(msg => {
                        if (msg.author?.id) {
                            addMember(msg.author.id, msg.author.username, msg.author.global_name, null);
                        }
                        if (msg.referenced_message?.author?.id) {
                            addMember(msg.referenced_message.author.id, msg.referenced_message.author.username, msg.referenced_message.author.global_name, null);
                        }
                        if (msg.mentions) {
                            msg.mentions.forEach(m => {
                                addMember(m.id, m.username, m.global_name, null);
                            });
                        }
                    });
                    channelMembersHarvestCache.set(rawChannelId, true);
                }
            } catch (e) {}
        }

        // 4. Fetch user's friends (Relationships)
        const tokenKey = res.locals.authToken || res.locals.token;
        if (tokenKey && !userRelationshipsCache.has(tokenKey)) {
            try {
                const relRes = await axios.get(
                    `${DEST_BASE}/users/@me/relationships`,
                    { headers: res.locals.headers }
                );
                if (Array.isArray(relRes.data)) {
                    relRes.data.forEach(r => {
                        if (r?.user?.id) {
                            addMember(r.user.id, r.user.username, r.user.global_name, null);
                        }
                    });
                    userRelationshipsCache.set(tokenKey, true);
                }
            } catch (e) {}
        }

        // 5. Include all cached users from userCache
        for (const [id, displayName] of userCache.entries()) {
            if (!results.has(id)) {
                addMember(id, displayName, displayName, null);
            }
        }
    }

    // Filter results if query is provided
    let list = Array.from(results.values());
    if (q.length > 0) {
        list = list.filter(m => {
            const nick = (m.nick || "").toLowerCase();
            const username = (m.username || "").toLowerCase();
            const globalName = (m.globalName || "").toLowerCase();
            const displayName = (m.displayName || "").toLowerCase();
            const id = (m.id || "").toLowerCase();
            return nick.includes(q) || username.includes(q) || globalName.includes(q) || displayName.includes(q) || id === q;
        });
    }

    // Sort alphabetically by displayName
    list.sort((a, b) => a.displayName.localeCompare(b.displayName));

    return list;
}

app.get(["/d/:channelid/send", "/g/:guildid/c/:channelid/send", "/wap/send"], getToken, async (req, res) => {
    const guildID = req.params.guildid ?? req.query.gid;
    const channelID = req.params.channelid ?? req.query.id;
    const guildPath = getGuildPath(guildID);
    const channelName = await getChannelName(req, res, guildID, channelID);
    const text = req.query.text ?? "";
    const recipient = req.query.recipient ?? "";
    const ping = req.query.ping;

    render(res, "send", {
        id: channelID,
        cname: channelName,
        gid: guildID,
        gpath: guildPath,
        text,
        recipient,
        ping,
    });
});

app.get(["/d/:channelid/reply/:messageid", "/g/:guildid/c/:channelid/reply/:messageid", "/wap/reply"], getToken, async (req, res) => {
    const guildID = req.params.guildid ?? req.query.gid;
    const channelID = req.params.channelid ?? req.query.id;
    const messageID = req.params.messageid ?? req.query.rec;
    const guildPath = getGuildPath(guildID);
    const channelName = await getChannelName(req, res, guildID, channelID);
    const text = req.query.text ?? "";
    const ping = req.query.ping;

    let recname = req.query.recname;
    if (!recname && messageCache.has(messageID)) {
        recname = messageCache.get(messageID).authorName;
    }
    const formattedRecname = normalizeStripEmoji(req, recname ?? "Unknown", res);

    render(res, "reply", {
        id: channelID,
        cname: channelName,
        rec: messageID,
        gid: guildID,
        gpath: guildPath,
        recname: formattedRecname,
        text,
        ping,
    });
});

// Mention search page
app.all([
    "/d/:channelid/mention",
    "/g/:guildid/c/:channelid/mention",
    "/wap/mention"
], getToken, async (req, res) => {
    const guildID = req.params.guildid ?? req.query?.gid ?? req.body?.gid;
    const channelID = req.params.channelid ?? req.query?.id ?? req.body?.id;
    const text = req.query?.text ?? req.body?.text ?? "";
    const q = req.query?.q ?? req.body?.q ?? "";
    const placeholder = req.query?.placeholder ?? req.body?.placeholder ?? "";
    const recipient = req.query?.recipient ?? req.body?.recipient ?? "";
    const ping = req.query?.ping ?? req.body?.ping;
    const autosend = (req.query?.autosend ?? req.body?.autosend ?? "") === "1";

    const guildPath = getGuildPath(guildID);
    const channelName = await getChannelName(req, res, guildID, channelID);

    const rawChannelId = decompressID(channelID, 'channel');
    const rawGuildId = (guildID && guildID !== '@me') ? decompressID(guildID, 'server') : (channelGuildCache.get(rawChannelId) || null);

    const members = await searchMembers(req, res, rawGuildId, rawChannelId, q);

    const memberList = members.map(m => {
        let selectUrl = `${guildPath}/${channelID}/mention/select?uid=${m.id}&text=${encodeURIComponent(text)}`;
        if (placeholder) selectUrl += `&placeholder=${encodeURIComponent(placeholder)}`;
        if (recipient) selectUrl += `&recipient=${encodeURIComponent(recipient)}`;
        if (ping !== undefined && ping !== '') selectUrl += `&ping=${encodeURIComponent(ping)}`;
        if (autosend) selectUrl += `&autosend=1`;
        if (guildID) selectUrl += `&gid=${guildID}`;
        selectUrl += `&id=${channelID}`;
        selectUrl += res.locals.tokenParam.replace('?', '&');

        return {
            ...m,
            formattedName: normalizeStripEmoji(req, m.displayName, res),
            tag: `@${m.username}`,
            selectUrl
        };
    });

    let cancelUrl;
    if (recipient) {
        cancelUrl = `${guildPath}/${channelID}/reply/${recipient}?text=${encodeURIComponent(text)}`;
        if (ping !== undefined && ping !== '') cancelUrl += `&ping=${encodeURIComponent(ping)}`;
        if (guildID) cancelUrl += `&gid=${guildID}`;
        cancelUrl += `&id=${channelID}`;
        cancelUrl += res.locals.tokenParam.replace('?', '&');
    } else {
        cancelUrl = `${guildPath}/${channelID}/send?text=${encodeURIComponent(text)}`;
        if (guildID) cancelUrl += `&gid=${guildID}`;
        cancelUrl += `&id=${channelID}`;
        cancelUrl += res.locals.tokenParam.replace('?', '&');
    }

    render(res, "mention", {
        id: channelID,
        gid: guildID,
        gpath: guildPath,
        cname: channelName,
        text,
        query: q,
        placeholder,
        recipient,
        ping: ping !== undefined ? String(ping) : '',
        autoSend: autosend,
        members: memberList,
        cancelUrl,
        token: res.locals.compressedToken,
    });
});

// Select a mention
app.all([
    "/d/:channelid/mention/select",
    "/g/:guildid/c/:channelid/mention/select",
    "/wap/mention/select"
], getToken, async (req, res) => {
    const guildID = req.params.guildid ?? req.query?.gid ?? req.body?.gid;
    const channelID = req.params.channelid ?? req.query?.id ?? req.body?.id;
    const selectedUserId = req.query?.uid ?? req.body?.uid;
    const text = req.query?.text ?? req.body?.text ?? "";
    const placeholder = req.query?.placeholder ?? req.body?.placeholder ?? "";
    const recipient = req.query?.recipient ?? req.body?.recipient ?? "";
    const ping = req.query?.ping ?? req.body?.ping;
    const autosend = (req.query?.autosend ?? req.body?.autosend ?? "") === "1";

    const guildPath = getGuildPath(guildID);
    const rawChannelId = decompressID(channelID, 'channel');

    let updatedText = text;
    if (placeholder) {
        const placeholderRegex = new RegExp(`<@${placeholder}>`, 'g');
        updatedText = updatedText.replace(placeholderRegex, `<@${selectedUserId}>`);
    } else {
        if (updatedText.length && !updatedText.endsWith(' ')) {
            updatedText += ' ';
        }
        updatedText += `<@${selectedUserId}> `;
    }

    // Check if any placeholders still remain
    const remainingPlaceholders = updatedText.match(/<@(\d{1,16})>/g);
    if (remainingPlaceholders && remainingPlaceholders.length > 0) {
        const nextPlaceholder = remainingPlaceholders[0].replace(/^<@|>$/g, '');
        let nextRedirect = `${guildPath}/${channelID}/mention?placeholder=${encodeURIComponent(nextPlaceholder)}&text=${encodeURIComponent(updatedText)}`;
        if (recipient) nextRedirect += `&recipient=${encodeURIComponent(recipient)}`;
        if (ping !== undefined && ping !== '') nextRedirect += `&ping=${encodeURIComponent(ping)}`;
        if (autosend) nextRedirect += `&autosend=1`;
        if (guildID) nextRedirect += `&gid=${guildID}`;
        nextRedirect += `&id=${channelID}`;
        nextRedirect += res.locals.tokenParam.replace('?', '&');
        res.redirect(nextRedirect);
        return;
    }

    // If no more placeholders remain and autosend was requested, send message directly
    if (autosend) {
        const send = {
            content: updatedText,
            flags: 0,
            mobile_network_type: "unknown",
            tts: false
        };
        if (recipient) {
            send.message_reference = {
                message_id: String(decompressID(recipient, 'message'))
            };
        }
        if (Number(ping) === 0) {
            send.allowed_mentions = {
                replied_user: false
            };
        }
        await axios.post(
            `${DEST_BASE}/channels/${rawChannelId}/messages`,
            send,
            { headers: res.locals.headers }
        );
        res.redirect(`${guildPath}/${channelID}${res.locals.tokenParam}`);
        return;
    }

    // Otherwise return to send / reply page with the mention inserted in text
    if (recipient) {
        let replyRedirect = `${guildPath}/${channelID}/reply/${recipient}?text=${encodeURIComponent(updatedText)}`;
        if (ping !== undefined && ping !== '') replyRedirect += `&ping=${encodeURIComponent(ping)}`;
        if (guildID) replyRedirect += `&gid=${guildID}`;
        replyRedirect += `&id=${channelID}`;
        replyRedirect += res.locals.tokenParam.replace('?', '&');
        res.redirect(replyRedirect);
    } else {
        let sendRedirect = `${guildPath}/${channelID}/send?text=${encodeURIComponent(updatedText)}`;
        if (guildID) sendRedirect += `&gid=${guildID}`;
        sendRedirect += `&id=${channelID}`;
        sendRedirect += res.locals.tokenParam.replace('?', '&');
        res.redirect(sendRedirect);
    }
});

// Send message (with attachment support)
app.post(["/d/:channelid/send", "/g/:guildid/c/:channelid/send", "/wap/send"], upload.single('file'), getToken, async (req, res) => {
    const guildID = req.params.guildid ?? req.body?.gid ?? req.query?.gid;
    const channelID = req.params.channelid ?? req.body?.id ?? req.query?.id;
    const guildPath = getGuildPath(guildID);
    const rawChannelId = decompressID(channelID, 'channel');
    const text = req.body?.text || "";

    // 1. If "Insert mention" was clicked
    if (req.body?.mention) {
        let mentionRedirect = `${guildPath}/${channelID}/mention?text=${encodeURIComponent(text)}`;
        if (req.body?.recipient) mentionRedirect += `&recipient=${encodeURIComponent(req.body.recipient)}`;
        if (req.body?.ping !== undefined) mentionRedirect += `&ping=${encodeURIComponent(req.body.ping)}`;
        if (guildID) mentionRedirect += `&gid=${guildID}`;
        mentionRedirect += `&id=${channelID}`;
        mentionRedirect += res.locals.tokenParam.replace('?', '&');
        res.redirect(mentionRedirect);
        return;
    }

    // 2. Check for placeholders like <@1>, <@2>, etc. (placeholder index <= 16 digits)
    const placeholders = text.match(/<@(\d{1,16})>/g);
    if (placeholders && placeholders.length > 0) {
        const firstPlaceholder = placeholders[0].replace(/^<@|>$/g, '');
        let mentionRedirect = `${guildPath}/${channelID}/mention?placeholder=${encodeURIComponent(firstPlaceholder)}&text=${encodeURIComponent(text)}&autosend=1`;
        if (req.body?.recipient) mentionRedirect += `&recipient=${encodeURIComponent(req.body.recipient)}`;
        if (req.body?.ping !== undefined) mentionRedirect += `&ping=${encodeURIComponent(req.body.ping)}`;
        if (guildID) mentionRedirect += `&gid=${guildID}`;
        mentionRedirect += `&id=${channelID}`;
        mentionRedirect += res.locals.tokenParam.replace('?', '&');
        res.redirect(mentionRedirect);
        return;
    }

    let attachments = null;
    if (req.file) {
        const attachmentsGet = await axios.post(
            `${DEST_BASE}/channels/${rawChannelId}/attachments`,
            {
                files: [{
                    filename: req.file.originalname,
                    file_size: req.file.size,
                    id: "0"
                }]
            },
            { headers: res.locals.headers }
        );

        const uploadUrl = attachmentsGet.data.attachments[0].upload_url;
        const uploadFilename = attachmentsGet.data.attachments[0].upload_filename;

        await axios.put(uploadUrl, req.file.buffer, {
            headers: {
                'Content-Type': req.file.mimetype || 'application/octet-stream',
                'Content-Length': req.file.size
            }
        });

        attachments = [{
            id: "0",
            filename: req.file.originalname,
            original_content_type: req.file.mimetype || "application/octet-stream",
            uploaded_filename: uploadFilename
        }];
    }

    const send = {
        content: text,
        flags: 0,
        mobile_network_type: "unknown",
        tts: false
    };
    if (attachments) {
        send.attachments = attachments;
    }
    if (req.body?.recipient) {
        send.message_reference = {
            message_id: String(decompressID(req.body.recipient, 'message'))
        }
    }
    if (Number(req.body?.ping) == 0) {
        send.allowed_mentions = {
            replied_user: false
        }
    }

    await axios.post(
        `${DEST_BASE}/channels/${rawChannelId}/messages`,
        send,
        { headers: res.locals.headers }
    );

    res.redirect(`${guildPath}/${channelID}${res.locals.tokenParam}`);
})

// Message options
app.all(["/d/:channelid/m/:messageid", "/g/:guildid/c/:channelid/m/:messageid", "/wap/msg"], getToken, async (req, res) => {
    const guildID = req.params.guildid ?? req.query?.gid ?? req.body?.gid;
    const channelID = req.params.channelid ?? req.query?.id ?? req.body?.id;
    const messageID = req.params.messageid ?? req.query?.msgid ?? req.body?.msgid;
    const guildPath = getGuildPath(guildID);
    const channelName = await getChannelName(req, res, guildID, channelID);

    let cached = messageCache.get(messageID);
    let rawAuthorName = cached?.authorName ?? req.query?.recname ?? req.body?.recname ?? "Unknown";
    let authorName = normalizeStripEmoji(req, rawAuthorName, res);
    let isOwn = cached?.isOwn ?? (req.query?.isOwn === '1' || req.body?.isOwn === '1');
    let content = cached?.content ?? (req.query?.content ?? req.body?.content ?? "");
    let rawContent = cached?.rawContent ?? (req.query?.rawContent ?? req.body?.rawContent ?? "");
    let links = cached?.links ?? extractLinks(rawContent);
    let attachments = cached?.attachments || [];

    const rawChannelId = decompressID(channelID, 'channel');
    const rawMessageId = decompressID(messageID, 'message');

    let rawServerId = '@me';
    if (guildID && guildID !== '@me') {
        try {
            rawServerId = decompressID(guildID, 'server');
        } catch (e) {
            rawServerId = guildID;
        }
    } else if (channelGuildCache.has(rawChannelId)) {
        rawServerId = channelGuildCache.get(rawChannelId);
    }

    if (!cached) {
        try {
            const singleMsg = (await axios.get(`${DEST_BASE}/channels/${rawChannelId}/messages/${rawMessageId}`, { headers: res.locals.headers })).data;
            if (singleMsg) {
                const parsed = parseMessageObject(req, res, singleMsg, rawServerId !== '@me' ? rawServerId : null);
                rawAuthorName = singleMsg.author?.username || "Unknown";
                authorName = parsed.author?.name || normalizeStripEmoji(req, rawAuthorName, res);
                content = parsed.content;
                rawContent = singleMsg.content || "";
                links = extractLinks(rawContent);
                attachments = parsed.attachments || [];
                const rawUserId = getRawUserIdFromToken(res.locals.token);
                isOwn = Boolean(singleMsg.author && (singleMsg.author.id === rawUserId || compressID(singleMsg.author.id) === res.locals.userID));
            }
        } catch (e) {}
    }

    render(res, "msg", {
        id: channelID,
        msgid: messageID,
        gid: guildID,
        gpath: guildPath,
        cname: channelName,
        authorName,
        isOwn,
        content,
        rawContent,
        links,
        attachments,
        rec: messageID,
        recname: rawAuthorName,
        token: res.locals.compressedToken,
    });
});

// Share message
app.all(["/d/:channelid/m/:messageid/share", "/g/:guildid/c/:channelid/m/:messageid/share", "/wap/share"], getToken, async (req, res) => {
    const guildID = req.params.guildid ?? req.query?.gid ?? req.body?.gid;
    const channelID = req.params.channelid ?? req.query?.id ?? req.body?.id;
    const messageID = req.params.messageid ?? req.query?.msgid ?? req.body?.msgid;
    const guildPath = getGuildPath(guildID);
    const channelName = await getChannelName(req, res, guildID, channelID);

    let cached = messageCache.get(messageID);
    let rawAuthorName = cached?.authorName ?? req.query?.recname ?? req.body?.recname ?? "Unknown";
    let authorName = normalizeStripEmoji(req, rawAuthorName, res);
    let rawContent = cached?.rawContent ?? (req.query?.rawContent ?? req.body?.rawContent ?? "");

    const rawChannelId = decompressID(channelID, 'channel');
    const rawMessageId = decompressID(messageID, 'message');

    let rawServerId = '@me';
    if (guildID && guildID !== '@me') {
        try {
            rawServerId = decompressID(guildID, 'server');
        } catch (e) {
            rawServerId = guildID;
        }
    } else if (channelGuildCache.has(rawChannelId)) {
        rawServerId = channelGuildCache.get(rawChannelId);
    }

    let timeStr = getIdTimestamp(res, rawMessageId);
    if (timeStr.endsWith('A')) timeStr = timeStr.slice(0, -1) + 'am';
    else if (timeStr.endsWith('P')) timeStr = timeStr.slice(0, -1) + 'pm';

    const shareBodyText = `${rawAuthorName} @ ${timeStr}:\n${rawContent}`;
    const messageLink = `https://discord.com/channels/${rawServerId}/${rawChannelId}/${rawMessageId}`;
    const shareLinkUrl = `sms:?body=${encodeURIComponent(messageLink)}`;
    const shareTextUrl = `sms:?body=${encodeURIComponent(shareBodyText)}`;

    render(res, "share", {
        id: channelID,
        msgid: messageID,
        gid: guildID,
        gpath: guildPath,
        cname: channelName,
        authorName,
        timeStr,
        rawContent,
        shareBodyText,
        messageLink,
        shareLinkUrl,
        shareTextUrl,
        token: res.locals.compressedToken,
    });
});

// Edit message page
app.get(["/d/:channelid/m/:messageid/edit", "/g/:guildid/c/:channelid/m/:messageid/edit", "/wap/edit"], getToken, async (req, res) => {
    const guildID = req.params.guildid ?? req.query?.gid ?? req.body?.gid;
    const channelID = req.params.channelid ?? req.query?.id ?? req.body?.id;
    const messageID = req.params.messageid ?? req.query?.msgid ?? req.body?.msgid;
    const guildPath = getGuildPath(guildID);
    const channelName = await getChannelName(req, res, guildID, channelID);

    let cached = messageCache.get(messageID);
    let isOwn = cached ? cached.isOwn : (req.query?.isOwn === '1' || req.body?.isOwn === '1');
    let rawContent = cached ? cached.rawContent : (req.query?.rawContent ?? req.body?.rawContent ?? "");

    if (!isOwn) {
        throw new Error("Access denied. You can only edit your own messages.");
    }

    render(res, "edit", {
        id: channelID,
        msgid: messageID,
        gid: guildID,
        gpath: guildPath,
        cname: channelName,
        text: rawContent,
        token: res.locals.compressedToken,
        textBoxSize: res.locals.settings.limitTextBoxSize ? 200 : 2000,
    });
});

// Edit message POST
app.post(["/d/:channelid/m/:messageid/edit", "/g/:guildid/c/:channelid/m/:messageid/edit", "/wap/edit"], getToken, async (req, res) => {
    const guildID = req.params.guildid ?? req.body?.gid ?? req.query?.gid;
    const channelID = req.params.channelid ?? req.body?.id ?? req.query?.id;
    const messageID = req.params.messageid ?? req.body?.msgid ?? req.query?.msgid;
    const guildPath = getGuildPath(guildID);

    const rawChannelId = decompressID(channelID, 'channel');
    const rawMessageId = decompressID(messageID, 'message');

    await axios.patch(
        `${DEST_BASE}/channels/${rawChannelId}/messages/${rawMessageId}`,
        { content: req.body.text },
        { headers: res.locals.headers }
    );

    if (messageCache.has(messageID)) {
        const cached = messageCache.get(messageID);
        cached.rawContent = req.body.text;
        cached.content = parseMessageContentText(req.body.text, res);
        cached.links = extractLinks(req.body.text);
        messageCache.set(messageID, cached);
    }

    res.redirect(`${guildPath}/${channelID}${res.locals.tokenParam}`);
});

// Delete message
app.all(["/d/:channelid/m/:messageid/delete", "/g/:guildid/c/:channelid/m/:messageid/delete", "/wap/delete"], getToken, async (req, res) => {
    const guildID = req.params.guildid ?? req.body?.gid ?? req.query?.gid;
    const channelID = req.params.channelid ?? req.body?.id ?? req.query?.id;
    const messageID = req.params.messageid ?? req.body?.msgid ?? req.query?.msgid;
    const guildPath = getGuildPath(guildID);

    const rawChannelId = decompressID(channelID, 'channel');
    const rawMessageId = decompressID(messageID, 'message');

    await axios.delete(
        `${DEST_BASE}/channels/${rawChannelId}/messages/${rawMessageId}`,
        { headers: res.locals.headers }
    );

    messageCache.delete(messageID);

    res.redirect(`${guildPath}/${channelID}${res.locals.tokenParam}`);
});

// Toggle reaction on a message
app.get([
    "/d/:channelid/m/:messageid/react/:emoji",
    "/g/:guildid/c/:channelid/m/:messageid/react/:emoji",
    "/wap/react_toggle"
], getToken, async (req, res) => {
    const guildID = req.params.guildid ?? req.query?.gid ?? req.body?.gid;
    const channelID = req.params.channelid ?? req.query?.id ?? req.body?.id;
    const messageID = req.params.messageid ?? req.query?.msgid ?? req.body?.msgid;
    const emojiParam = req.params.emoji ?? req.query?.emoji;
    const action = req.query?.action ?? req.body?.action;
    const guildPath = getGuildPath(guildID);

    const rawChannelId = decompressID(channelID, 'channel');
    const rawMessageId = decompressID(messageID, 'message');
    const decodedEmoji = decodeURIComponent(emojiParam);
    const encodedEmoji = encodeURIComponent(decodedEmoji);

    const cached = messageCache.get(messageID);
    const alreadyReacted = cached?.reactions?.some(r =>
        Boolean(r.me) && (
            r.emoji?.name === decodedEmoji ||
            `${r.emoji?.name}:${r.emoji?.id}` === decodedEmoji ||
            (r.emoji?.id && decodedEmoji.includes(r.emoji.id))
        )
    );

    const shouldRemove = action ? action === 'remove' : Boolean(alreadyReacted);

    try {
        if (shouldRemove) {
            await axios.delete(
                `${DEST_BASE}/channels/${rawChannelId}/messages/${rawMessageId}/reactions/${encodedEmoji}/@me`,
                { headers: res.locals.headers }
            );
            if (cached && cached.reactions) {
                const target = cached.reactions.find(r =>
                    r.emoji?.name === decodedEmoji ||
                    `${r.emoji?.name}:${r.emoji?.id}` === decodedEmoji ||
                    (r.emoji?.id && decodedEmoji.includes(r.emoji.id))
                );
                if (target) {
                    target.me = false;
                    target.count = Math.max(0, (target.count || 1) - 1);
                    if (target.count === 0) {
                        cached.reactions = cached.reactions.filter(r => r !== target);
                    }
                }
            }
        } else {
            await axios.put(
                `${DEST_BASE}/channels/${rawChannelId}/messages/${rawMessageId}/reactions/${encodedEmoji}/@me`,
                {},
                { headers: res.locals.headers }
            );
            if (cached && cached.reactions) {
                const target = cached.reactions.find(r =>
                    r.emoji?.name === decodedEmoji ||
                    `${r.emoji?.name}:${r.emoji?.id}` === decodedEmoji ||
                    (r.emoji?.id && decodedEmoji.includes(r.emoji.id))
                );
                if (target) {
                    target.me = true;
                    target.count = (target.count || 0) + 1;
                } else {
                    const customMatch = decodedEmoji.match(/^([a-zA-Z0-9_]+):(\d+)$/);
                    if (customMatch) {
                        cached.reactions.push({
                            emoji: { name: customMatch[1], id: customMatch[2] },
                            count: 1,
                            me: true
                        });
                    } else {
                        cached.reactions.push({
                            emoji: { name: decodedEmoji, id: null },
                            count: 1,
                            me: true
                        });
                    }
                }
            }
        }
    } catch (e) {
        console.warn("Reaction toggle error:", e?.message);
    }

    res.redirect(`${guildPath}/${channelID}${res.locals.tokenParam}`);
});

// React to message page
app.get([
    "/d/:channelid/m/:messageid/react",
    "/g/:guildid/c/:channelid/m/:messageid/react",
    "/wap/react"
], getToken, async (req, res) => {
    const guildID = req.params.guildid ?? req.query?.gid ?? req.body?.gid;
    const channelID = req.params.channelid ?? req.query?.id ?? req.body?.id;
    const messageID = req.params.messageid ?? req.query?.msgid ?? req.body?.msgid;
    const guildPath = getGuildPath(guildID);
    const channelName = await getChannelName(req, res, guildID, channelID);

    let cached = messageCache.get(messageID);
    let rawAuthorName = cached?.authorName ?? req.query?.recname ?? req.body?.recname ?? "Unknown";
    let authorName = normalizeStripEmoji(req, rawAuthorName, res);
    let content = cached?.content ?? (req.query?.content ?? req.body?.content ?? "");
    let reactions = cached?.reactions ? parseMessageObject(req, res, { reactions: cached.reactions }).reactions : [];

    render(res, "react", {
        id: channelID,
        msgid: messageID,
        gid: guildID,
        gpath: guildPath,
        cname: channelName,
        authorName,
        content,
        reactions,
        token: res.locals.compressedToken,
    });
});

// React to message POST
app.post([
    "/d/:channelid/m/:messageid/react",
    "/g/:guildid/c/:channelid/m/:messageid/react",
    "/wap/react"
], getToken, async (req, res) => {
    const guildID = req.params.guildid ?? req.body?.gid ?? req.query?.gid;
    const channelID = req.params.channelid ?? req.body?.id ?? req.query?.id;
    const messageID = req.params.messageid ?? req.body?.msgid ?? req.query?.msgid;
    const guildPath = getGuildPath(guildID);

    const rawChannelId = decompressID(channelID, 'channel');
    const rawMessageId = decompressID(messageID, 'message');

    let inputEmoji = (req.body?.emoji ?? "").trim();
    if (inputEmoji) {
        const customMatch = inputEmoji.match(/^<?a?:?([a-zA-Z0-9_]+):(\d+)>?$/);
        let resolvedEmoji;
        if (customMatch) {
            resolvedEmoji = `${customMatch[1]}:${customMatch[2]}`;
        } else if (inputEmoji.startsWith(':') && inputEmoji.endsWith(':')) {
            resolvedEmoji = emoji.replace_colons(inputEmoji);
        } else {
            resolvedEmoji = inputEmoji;
        }

        const encodedEmoji = encodeURIComponent(resolvedEmoji);
        const cached = messageCache.get(messageID);
        const alreadyReacted = cached?.reactions?.some(r =>
            Boolean(r.me) && (
                r.emoji?.name === resolvedEmoji ||
                `${r.emoji?.name}:${r.emoji?.id}` === resolvedEmoji ||
                (r.emoji?.id && resolvedEmoji.includes(r.emoji.id))
            )
        );

        try {
            if (alreadyReacted) {
                await axios.delete(
                    `${DEST_BASE}/channels/${rawChannelId}/messages/${rawMessageId}/reactions/${encodedEmoji}/@me`,
                    { headers: res.locals.headers }
                );
                if (cached && cached.reactions) {
                    const target = cached.reactions.find(r =>
                        r.emoji?.name === resolvedEmoji ||
                        `${r.emoji?.name}:${r.emoji?.id}` === resolvedEmoji ||
                        (r.emoji?.id && resolvedEmoji.includes(r.emoji.id))
                    );
                    if (target) {
                        target.me = false;
                        target.count = Math.max(0, (target.count || 1) - 1);
                        if (target.count === 0) {
                            cached.reactions = cached.reactions.filter(r => r !== target);
                        }
                    }
                }
            } else {
                await axios.put(
                    `${DEST_BASE}/channels/${rawChannelId}/messages/${rawMessageId}/reactions/${encodedEmoji}/@me`,
                    {},
                    { headers: res.locals.headers }
                );
                if (cached && cached.reactions) {
                    const target = cached.reactions.find(r =>
                        r.emoji?.name === resolvedEmoji ||
                        `${r.emoji?.name}:${r.emoji?.id}` === resolvedEmoji ||
                        (r.emoji?.id && resolvedEmoji.includes(r.emoji.id))
                    );
                    if (target) {
                        target.me = true;
                        target.count = (target.count || 0) + 1;
                    } else {
                        const customResolvedMatch = resolvedEmoji.match(/^([a-zA-Z0-9_]+):(\d+)$/);
                        if (customResolvedMatch) {
                            cached.reactions.push({
                                emoji: { name: customResolvedMatch[1], id: customResolvedMatch[2] },
                                count: 1,
                                me: true
                            });
                        } else {
                            cached.reactions.push({
                                emoji: { name: resolvedEmoji, id: null },
                                count: 1,
                                me: true
                            });
                        }
                    }
                }
            }
        } catch (e) {
            console.warn("Failed to update reaction:", e?.message);
        }
    }

    res.redirect(`${guildPath}/${channelID}${res.locals.tokenParam}`);
});

app.get(["/set", "/wap/set"], getToken, (req, res) => {
    render(res, "settings", {
        token: req.query.token,
        themes,
        timePreview: getIdTimestamp(res, ((BigInt(Date.now()) - 1420070400000n) << 22n).toString())
    });
})

// Error handler
app.use((err, req, res, next) => {
    console.log(err);
    render(res, "error", { error: getError(err) });
})

app.listen(process.env.PORT, () => {
    console.log(`Server is running on http://localhost:${process.env.PORT}`);
});

testGateway();
