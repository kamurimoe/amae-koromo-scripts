import * as pb from "protobufjs";
type ENV = {
    "accessToken": string,
    "preferredServer": string | undefined,
    "OAUTH_TYPE": number,
}

declare class MajsoulProtoCodec {
    private _pb: pb.Root;
    private _index: number;
    private _wrapper: any;
    private _inflightRequests: {};
    private version: any;
    private rawDefinition: any;

    constructor(pbDef: any, version: string);

    lookupMethod(path: string): pb.Method | null

    decodeMessage(buf: Uint8Array | Buffer): {
        type: number,
        reqIndex: number,
        methodName: string,
        payload: Uint8Array | Buffer,
    }

    decodeDataMessage(buf: Uint8Array | Buffer, typeName: string): {
        dataType: string,
        payload: Uint8Array | Buffer,
    }

    encodeRequest({methodName, payload}: { methodName: string, payload: Uint8Array | Buffer }): Uint8Array | Buffer;
}

declare class MajsoulConnection {
    private _servers: any;
    private _timeout: number;
    private _pendingMessages: [];
    public _codec: any;
    public clientVersionString: string;
    private _onConnect: any;

    constructor(server: any, codec: any, onConnect: any, timeout: number)

    reconnect(): void

    waitForReady(): Promise<any>;

    _createWaiter(): void;

    _wait(): Promise<any>;

    close(): void;

    readMessage(): Promise<any>;

    rpcCall(methodName: string, payload: any): Promise<any>;
}

declare function getRes(path: string, bustCache: any): Promise<any>;

declare function fetchLatestDataDefinition(): Promise<{ version: string, dataDefinition: any }>

declare function createMajsoulConnection(env:ENV): Promise<MajsoulConnection>;

export {
    type ENV,
    MajsoulProtoCodec,
    MajsoulConnection,
    createMajsoulConnection,
    fetchLatestDataDefinition,
    getRes,
}