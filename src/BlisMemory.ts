import * as builder from 'botbuilder'
import { BlisDebug} from './BlisDebug';
import { Utils} from './Utils';
import { CueCommand } from './Memory/CueCommand';
import { Pager } from './Memory/Pager';
import { TrainHistory } from './Memory/TrainHistory';
import { EntityLookup } from './Memory/EntityLookup';
import { BotMemory } from './Memory/BotMemory';
import { BotState } from './Memory/BotState';

var redis = require("redis");

export const MemoryType =
{
    LASTSTEP: "LASTSTEP", 
    CURSTEP: "CURSTEP", 
    TRAINSTEPS: "TRAINSTEPS",
    CUECOMMAND: "CUECOMMAND",       // Command to call after input prompt
    PAGE: "PAGE",                   // Current page on paging UI
    POSTS: "POSTS"                  // Array of last messages sent to user
}

export class BlisMemory {

    // TODO: create own redis account
    private static redisClient = redis.createClient(6380, 'libot.redis.cache.windows.net', { auth_pass: 'SKbD9LlGF0NdPm6NpIyHpslRvqB3/z4dYYurFakJ4HM=', tls: { servername: 'libot.redis.cache.windows.net' } });

    private memCache = {};

    constructor(private userkey : string)
    {
    }

    public static GetMemory(session : builder.Session) : BlisMemory
    {
        // Create key for this user from their address
        let key = Utils.HashCode(JSON.stringify(session.message.address.user));
        return new BlisMemory(`${key}`);
    }

    private Key(datakey : string) : string {
        return `${this.userkey}_${datakey}`
    }

    public async GetAsync(datakey : string) : Promise<any> {
        let that = this;
        let key = this.Key(datakey);
        let cacheData = this.memCache[key];
        if (cacheData)
        {
            return new Promise(function(resolve,reject) {
                BlisDebug.Log(`-< ${key} : ${cacheData}`, 'memverbose');
                resolve(cacheData);
            });
        };
        return new Promise(function(resolve,reject) {
            BlisMemory.redisClient.get(key, function(err, data)
            {
                if(err !== null) return reject(err);
                that.memCache[key] = data;
                BlisDebug.Log(`R< ${key} : ${data}`, 'memory');
                resolve(data);
            });
        });
    }

    public async SetAsync(datakey : string, value : any) {
        if (value == null)
        {
            return this.DeleteAsync(datakey);
        }

        let that = this;
        let key = this.Key(datakey);

        return new Promise(function(resolve,reject){
            // First check mem cache to see if anything has changed, if not, can skip write
            let cacheData = that.memCache[key];
            if (cacheData == value)
            {
                BlisDebug.Log(`-> ${key} : ${value}`, 'memverbose');
                resolve("Cache");
            }
            else
            {
                // Write to redis cache
                BlisMemory.redisClient.set(key, value, function(err, data)
                {
                    if(err !== null) return reject(err);
                    that.memCache[key] = value;
                    BlisDebug.Log(`W> ${key} : ${value}`, 'memory');
                    resolve(data);
                });
            }
        });
    }

    public async DeleteAsync(datakey : string) {
        let that = this;
        let key = this.Key(datakey);
        return new Promise(function(resolve,reject){
            // First check mem cache to see if already null, if not, can skip write
            let cacheData = that.memCache[key];
            if (!cacheData)
            {
                BlisDebug.Log(`-> ${key} : -----`, 'memverbose');
                resolve("Cache");
            }
            else
            {
                BlisMemory.redisClient.del(key, function(err, data)
                {
                    if(err !== null) return reject(err);
                    that.memCache[key] = null;
                    BlisDebug.Log(`D> ${key} : -----`, 'memory');
                    resolve(data);
                });
            }
        });
    }

    public Get(datakey : string, cb : (err, data) => void) {
        let key = this.Key(datakey);

        let cacheData = this.memCache[key];
        if (cacheData)
        {
            BlisDebug.Log(`-] ${key} : ${cacheData}`, 'memverbose');
            cb(null, cacheData);
        }
        BlisMemory.redisClient.get(key, (err, data)=> {
            if (!err)
            {
                this.memCache[key] = data;
            }
            BlisDebug.Log(`R] ${key} : ${data}`, 'memory');
            cb(err, data);
        });
    }

    private Set(datakey : string, value : any, cb : (err, data) => void) {
        let key = this.Key(datakey);
        this.memCache[key] = value;
        BlisDebug.Log(`W] ${key} : ${value}`, 'memory');
        BlisMemory.redisClient.set(key, value, cb);
    }

    private Delete(datakey : string, cb : (err, data) => void) {
        let key = this.Key(datakey);
        this.memCache[key] = null;
        BlisDebug.Log(`D] ${key} : -----`, 'memory');
        BlisMemory.redisClient.del(key,cb);
    }

    public async Init(appId : string) : Promise<void>
    {
        await this.BotState().Clear(appId);
        await this.BotMemory().Clear();
        await this.EntityLookup().Clear();
        await this.TrainHistory().Clear();
        await this.CueCommand().Clear();
        await this.Pager().Clear();
    }

    /** Clear memory associated with a session */
    public async EndSession() : Promise<void>
    {
        await this.BotState().SetSessionId(null);
        await this.BotState().SetInTeach(false);
        await this.TrainHistory().ClearLastStep();
        await this.BotMemory().Clear();
    }

    /** Init memory for a session */
    public async StartSession(sessionId : string, inTeach : boolean) : Promise<void>
    {
        await this.EndSession();
        await this.BotState().SetSessionId(sessionId);
        await this.BotState().SetInTeach(inTeach);
    }

    public EntityLookup() : any
    {
        EntityLookup.memory = this;
        return EntityLookup;
    }

    public BotMemory() : any
    {
        BotMemory.memory = this;
        return BotMemory;
    }

    public TrainHistory() : any
    {
        TrainHistory.memory = this;
        return TrainHistory;
    }

    public BotState() : any
    {
        BotState.memory = this;
        return BotState;
    }

    public CueCommand() : any
    {
        CueCommand.memory = this;
        return CueCommand;
    }

    public Pager() : any
    {
        Pager.memory = this;
        return Pager;
    }

    //--------------------------------------------------------
    // Debug Tools
    //--------------------------------------------------------

    public async Dump() : Promise<string> {
        let text = "";
        text += `BotState: ${await this.BotState().ToString()}\n\n`;
        text += `Steps: ${await this.TrainHistory().ToString()}\n\n`;
        text += `Memory: {${await this.BotMemory().ToString()}}\n\n`;
        text += `EntityLookup: ${await this.EntityLookup().ToString()}\n\n`;
        return text;
    }
}