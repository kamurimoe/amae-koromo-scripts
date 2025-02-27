const protobuf = require("protobufjs");
const assert = require("assert");
const WebSocket = require("ws");
const axios = require('axios');
import { wrapper } from 'axios-cookiejar-support';

const tough = require('tough-cookie');
const {v4} = require("uuid");
const fs = require("fs");
const p = require("path");
const crypto = require("crypto");

const URL_BASE = 'https://game.maj-soul.com/1/'
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.88 Safari/537.36";
const HEADERS = {
    "User-Agent": USER_AGENT,
    "If-Modified-Since": "0",
    Referer: URL_BASE,
    "sec-ch-ua": '"Chromium";v="100", "Google Chrome";v="100"',
    "sec-ch-ua-platform": "Windows",
};

/**
 *  * Shuffles array in place.
 *   * @param {Array} a items An array containing the items.
 *    */
function shuffle(a) {
    var j, x, i;
    for (i = a.length - 1; i > 0; i--) {
        j = Math.floor(Math.random() * (i + 1));
        x = a[i];
        a[i] = a[j];
        a[j] = x;
    }
    return a;
}

class MajsoulProtoCodec {
    constructor(pbDef, version) {
        this._pb = protobuf.Root.fromJSON(pbDef);
        this._index = 1;
        this._wrapper = this._pb.nested.lq.Wrapper;
        this._inflightRequests = {};
        this.version = version;
        this.rawDefinition = pbDef;
    }

    lookupMethod(path) {
        if (typeof path === "string") {
            path = path.split(".");
        }
        if (0 === path.length) {
            return null;
        }
        const service = this._pb.lookupService(path.slice(0, -1));
        if (!service) {
            return null;
        }
        const name = path[path.length - 1];
        return service.methods[name];
    }

    /**
     * @param {Buffer} buf
     */
    decodeMessage(buf) {
        const {REQUEST, RESPONSE} = MajsoulProtoCodec;
        const type = buf[0];
        assert([REQUEST, RESPONSE].includes(type));
        const reqIndex = buf[1] | (buf[2] << 8);
        const msg = this._wrapper.decode(buf.slice(3));
        let typeObj, methodName;
        if (type === REQUEST) {
            methodName = msg.name;
            const methodObj = this.lookupMethod(msg.name);
            const typeName = methodObj.requestType;
            typeObj = methodObj.parent.parent.lookupType(typeName);
        } else {
            ({typeObj, methodName} = this._inflightRequests[reqIndex] || {});
            if (!typeObj) {
                throw new Error(`Unknown request ${reqIndex}`);
            }
            delete this._inflightRequests[reqIndex];
        }
        return {
            type,
            reqIndex,
            methodName,
            payload: typeObj.decode(msg.data),
        };
    }

    decodeDataMessage(buf, typeName) {
        const msg = this._wrapper.decode(buf);
        const typeObj = this._pb.lookupType(typeName || msg.name);
        return {
            dataType: msg.name,
            payload: typeObj.decode(msg.data),
        };
    }

    encodeRequest({methodName, payload}) {
        const currentIndex = this._index++;
        const methodObj = this.lookupMethod(methodName);
        const requestType = methodObj.parent.parent.lookupType(methodObj.requestType);
        const responseType = methodObj.parent.parent.lookupType(methodObj.responseType);
        const msg = this._wrapper
            .encode({
                name: methodName,
                data: requestType.encode(payload).finish(),
            })
            .finish();
        this._inflightRequests[currentIndex] = {
            methodName,
            typeObj: responseType,
        };
        return Buffer.concat([Buffer.from([MajsoulProtoCodec.REQUEST, currentIndex & 0xff, currentIndex >> 8]), msg]);
    }
}

Object.assign(MajsoulProtoCodec, {
    REQUEST: 2,
    RESPONSE: 3,
});

class MajsoulConnection {
    constructor(server, codec, onConnect, timeout = 15000) {
        if (!Array.isArray(server)) {
            server = [server];
        }
        this.clientVersionString = undefined;
        this._servers = server;
        this._timeout = timeout;
        this._pendingMessages = [];
        this._codec = codec;
        this._onConnect = onConnect;
        this.reconnect();
    }

    reconnect() {
        this._ready = false;
        if (this._socket) {
            this._socket.terminate();
        }
        this._createWaiter();
        shuffle(this._servers);
        const server = this._servers[0];
        console.log("Connecting to " + server);
        this._socket = new WebSocket(server, {
            headers: HEADERS,
            insecureHTTPParser: true,
        });
        this._socket.on("message", (data) => {
            this._pendingMessages.push(data);
            this._waiterResolve();
        });
        this._socket.on("unexpected-response", (_, res) => {
            console.log("MajsoulConnection: Unexpected response:", res.statusCode);
            try {
                this._socket.terminate();
            } catch (e) {
            }
            this._waiterResolve();
            if (res.statusCode >= 500) {
                this.reconnect();
            }
        });
        this._socket.on("open", () => {
            this._waiterResolve();
            this._pendingMessages = [];
            this._onConnect(this)
                .then(() => {
                    this._ready = true;
                    this._waiterResolve();
                })
                .catch((e) => {
                    console.error("Error in onOpen:", e);
                    this._socket.terminate();
                    this._socket = null;
                    this._waiterResolve();
                    setTimeout(() => this._waiterResolve(), 100);
                });
        });
    }

    async waitForReady() {
        while (!this._ready) {
            if (
                !this._socket ||
                this._socket.readyState === WebSocket.CLOSED ||
                this._socket.readyState === WebSocket.CLOSING
            ) {
                console.log("WebSocket closed before successful connection");
                throw new Error("WebSocket closed before successful connection");
            }
            this._createWaiter();
            await this._wait();
        }
    }

    _createWaiter() {
        if (this._waiter && !this._waiter._resolved) {
            return;
        }
        this._waiter = new Promise((resolve) => {
            var self = this;
            this._waiterResolve = function () {
                resolve();
                self._waiter._resolved = true;
            };
        });
    }

    async _wait() {
        try {
            await Promise.race([
                this._waiter,
                new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), this._timeout)),
            ]);
        } catch (e) {
            if (e.message !== "timeout") {
                throw e;
            }
            throw new Error("timeout");
        }
    }

    close() {
        this._socket.terminate();
        this._pendingMessages.push(undefined);
        this._waiterResolve();
    }

    async readMessage() {
        while (!this._pendingMessages.length) {
            if (!this._socket || this._socket.readyState === WebSocket.CLOSED) {
                return undefined;
            }
            await this._wait();
            this._createWaiter();
        }
        return this._pendingMessages.shift();
    }

    async rpcCall(methodName, payload) {
        if (!this._socket) {
            throw new Error("Connection is broken");
        }
        if (this._socket.readyState === WebSocket.CONNECTING) {
            await this._wait();
        }
        if (this._socket.readyState !== WebSocket.OPEN) {
            this._pendingMessages = [];
            throw new Error("Connection is not opened");
        }
        const req = this._codec.encodeRequest({methodName, payload});
        this._socket.send(req);
        const resp = await this.readMessage();
        return this._codec.decodeMessage(resp).payload;
    }
}

const cookiejar = new tough.CookieJar();
const api = wrapper(axios.create());

async function getRes(path, bustCache) {
    let url = `${URL_BASE}${path}`;
    const cacheHash = crypto.createHash("sha256").update(url).digest("hex");
    if (bustCache) {
        url += "?randv=" + Math.random().toString().slice(2);
    }
    const cacheDir = p.join(__dirname, ".cache");
    const cacheFile = p.join(cacheDir, cacheHash);

    return await api({
        method: 'GET',
        url: url,
        timeout:3000,
        responseType: 'json',
        jar: cookiejar,
        headers: HEADERS,
        withCredentials: true
    }).then((r)=>{
        if (r.data === undefined) {
            throw new Error("Failed to get resource " + path);
        }
        fs.mkdirSync(cacheDir, {recursive: true});
        fs.writeFileSync(p.join(cacheDir, cacheHash), JSON.stringify(r.data));
        return r.data;
    }).catch((e) => {
        try {
            console.log(`Using cache for ${path} (${cacheHash})`);
            return JSON.parse(fs.readFileSync(cacheFile, {encoding: "utf8"}));
        } catch (e) {
            console.log(e);
        }
        return Promise.reject(e);
    });
}

async function fetchLatestDataDefinition() {
    const versionInfo = await getRes("version.json", true);
    const resInfo = await getRes(`resversion${versionInfo.version}.json`);
    const pbVersion = resInfo.res["res/proto/liqi.json"].prefix;
    const pbDef = await getRes(`${pbVersion}/res/proto/liqi.json`);
    return {
        version: pbVersion,
        dataDefinition: pbDef,
    };
}

async function createMajsoulConnection(env) {
    let {accessToken, preferredServer, OAUTH_TYPE} = env;
    let serverListUrl = undefined;
    const wsScheme = "wss";
    const versionInfo = await getRes("version.json", true);
    const resInfo = await getRes(`resversion${versionInfo.version}.json`);
    const pbVersion = resInfo.res["res/proto/liqi.json"].prefix;
    const pbDef = await getRes(`${pbVersion}/res/proto/liqi.json`);
    const config = await getRes(`${resInfo.res["config.json"].prefix}/config.json`);
    const ipDef = config.ip.filter((x) => x.name === "player")[0];
    const triedListUrl = [];
    let serverList = null;
    let numTries = 0;
    let lastError = null;
    while (true) {
        numTries++;
        if (numTries > 10) {
            throw lastError;
        }
        try {
            if (!serverListUrl) {
                preferredServer = shuffle((preferredServer || "").split(","))[0];
                serverListUrl = ipDef.region_urls[preferredServer] || ipDef.region_urls.mainland;
                if (!serverListUrl) {
                    const allServerListUrls = shuffle(
                        ipDef.region_urls.length ? ipDef.region_urls : Object.values(ipDef.region_urls)
                    );
                    if (
                        allServerListUrls.length > 1 &&
                        (allServerListUrls[0].url || allServerListUrls[0]) === triedListUrl[triedListUrl.length - 1]
                    ) {
                        allServerListUrls.shift();
                    }
                    serverListUrl = allServerListUrls[0];
                    if (serverListUrl.url) {
                        serverListUrl = serverListUrl.url;
                    }
                    assert(typeof serverListUrl === "string");
                    triedListUrl.push(serverListUrl);
                }
                serverListUrl += "?service=ws-gateway&protocol=ws&ssl=true&rv=" + Math.random().toString().slice(2);
                console.log(serverListUrl);
            }

            const res = await api({
                method: 'GET',
                url: serverListUrl,
                responseType: 'json',
                timeout: 2500,
                jar: cookiejar,
                headers: HEADERS,
                withCredentials: true
            })
            serverList = res.data;
            // console.log(serverList);
            if (serverList.maintenance) {
                console.log("Maintenance in progress");
                await new Promise((resolve) => setTimeout(resolve, 30000));
                return;
            }
            break;
        } catch (e) {
            lastError = e;
            serverListUrl = null;
            preferredServer = "";
            await new Promise((resolve) => setTimeout(resolve, 1000 + numTries * 1000));
        }
    }
    const proto = new MajsoulProtoCodec(pbDef, pbVersion);
    const serverIndex = Math.floor(Math.random() * serverList.servers.length);
    const type = parseInt(OAUTH_TYPE) || 0;
    let server = serverList.servers[serverIndex];
    if (server.indexOf("maj-soul") > -1) {
        server += "/gateway";
    }
    let shouldRetry = false;
    try {
        const conn = new MajsoulConnection(`${wsScheme}://${server}`, proto, async (conn) => {
            console.log("Connection established, sending heartbeat");
            await conn.rpcCall(".lq.Lobby.heatbeat", {no_operation_counter: 0});
            await new Promise((resolve) => setTimeout(resolve, 100));
            shouldRetry = false;
            console.log(`Authenticating (${versionInfo.version})`);
            conn.clientVersionString = "web-" + versionInfo.version.replace(/\.[a-z]+$/i, "");
            if (type === 7) {
                const [code, uid] = accessToken.split("-");
                const resp = await conn.rpcCall(".lq.Lobby.oauth2Auth", {
                    type,
                    code,
                    uid,
                    client_version_string: conn.clientVersionString,
                });
                accessToken = resp.access_token;
            }
            // console.log(accessToken);
            let resp = await conn.rpcCall(".lq.Lobby.oauth2Check", {type, access_token: accessToken});
            // console.log(resp);
            if (!resp.has_account) {
                await new Promise((res) => setTimeout(res, 2000));
                resp = await conn.rpcCall(".lq.Lobby.oauth2Check", {type, access_token: accessToken});
            }
            assert(resp.has_account);
            resp = await conn.rpcCall(".lq.Lobby.oauth2Login", {
                type,
                access_token: accessToken,
                reconnect: false,
                device: {
                    platform: "pc",
                    hardware: "pc",
                    os: "windows",
                    os_version: "win10",
                    is_browser: true,
                    software: "Chrome",
                    sale_platform: "web",
                },
                random_key: v4(),
                client_version: {resource: versionInfo.version},
                currency_platforms: [],
                client_version_string: conn.clientVersionString,
            });
            // console.log(resp);
            assert(resp.account_id);
            console.log("Connection ready");
        });
        await conn.waitForReady();
        return conn;
    } catch (e) {
        console.error(e);
        if (!shouldRetry) {
            console.error("Not retrying");
            return Promise.reject(e);
        }
        return createMajsoulConnection(accessToken);
    }
}


exports.MajsoulProtoCodec = MajsoulProtoCodec;
exports.MajsoulConnection = MajsoulConnection;
exports.createMajsoulConnection = createMajsoulConnection;
exports.fetchLatestDataDefinition = fetchLatestDataDefinition;
exports.getRes = getRes;
