import {createMajsoulConnection, MajsoulConnection,type ENV} from './majsoul'
import {lq} from "./majsoulPb";


class paifuFetcher {
    private _conn: MajsoulConnection | null = null

    async connect(env:ENV) {
        this._conn = await createMajsoulConnection(env);
    }

    async getPaifuJson(uuid: string) {
        const codec = this._conn._codec;
        // get
        const form_uuid = uuid.replace(/^.*=(.*)_a.*$/, "$1");
        const gameRecord = await this._conn.rpcCall(".lq.Lobby.fetchGameRecord", {
            game_uuid: form_uuid, client_version_string:  this._conn.clientVersionString
        });
        this._conn.close();
        // decode
        const gameDetailRecordsWrapper = codec._wrapper.decode(gameRecord.data);
        const gameDetailRecords =codec._pb.nested.lq.GameDetailRecords.decode(
            gameDetailRecordsWrapper.data
        );
        let gameDetailRecordsJson = JSON.parse(JSON.stringify(gameDetailRecords));
        // format
        if (gameDetailRecords.version === 0) {
            for (let i in gameDetailRecords.records) {
                const record = codec._wrapper.decode(gameDetailRecords.records[i]);
                const name_split = record.name.split('.');
                const pb = codec._pb.nested[name_split[1]][name_split[2]];
                const data = JSON.parse(JSON.stringify(pb.decode(record.data)));
                gameDetailRecordsJson.records[i] = {name: record.name, data: data};
            }
        } else if (gameDetailRecords.version === 210715) {
            for (let i in gameDetailRecords.actions) {
                if (gameDetailRecords.actions[i].type === 1) {
                    const record = codec._wrapper.decode(
                        gameDetailRecords.actions[i].result
                    );
                    const name_split = record.name.split('.');
                    const pb = codec._pb.nested[name_split[1]][name_split[2]];
                    const data = JSON.parse(JSON.stringify(pb.decode(record.data)));
                    gameDetailRecordsJson.actions[i].result = {name: record.name, data: data};
                }
            }
        } else {
            throw "Unknown version: " + gameDetailRecords.version;
        }
        gameRecord.data = "";
        let gameRecordJson = JSON.parse(JSON.stringify(gameRecord));
        gameRecordJson.data = {
            name: gameDetailRecordsWrapper.name,
            data: gameDetailRecordsJson,
        };
        return gameRecordJson
    }

}

export {paifuFetcher,lq,type ENV}