import { BlisMemory } from '../BlisMemory';
import { BlisDebug } from '../BlisDebug';
import { EntityBase, MemoryValue, FilledEntity } from 'blis-models'

export class ClientMemoryManager {

    public blisMemory : BlisMemory = null;
    private entities : EntityBase[] = null;

    public constructor(memory : BlisMemory, entities : EntityBase[])
    {
        this.entities = entities;
        this.blisMemory = memory;
    }

    public FindEntity(entityName : string) : EntityBase {
        let match = this.entities.find(e => e.entityName == entityName);
        return match;
    }

    public async RememberEntityAsync(entityName : string, entityValue : string) : Promise<void> {

        let entity = this.FindEntity(entityName);

        if (!entity) {
            BlisDebug.Error(`Can't find Entity named: ${entityName}`);
            return null;
        }
        
        await this.blisMemory.BotMemory.Remember(entity.entityName, entity.entityId, entityValue, entity.isMultivalue);
    }

    public async RememberEntitiesAsync(entityName : string, entityValues : string[]) : Promise<void> {

        let entity = this.FindEntity(entityName);

        if (!entity) {
            BlisDebug.Error(`Can't find Entity named: ${entityName}`);
            return null;
        }
        
        await this.blisMemory.BotMemory.RememberMany(entity.entityName, entity.entityId, entityValues, entity.isMultivalue);
    }

    public async ForgetEntityAsync(entityName : string, value : string = null) : Promise<void> {
        
        let entity = this.FindEntity(entityName);

        if (!entity) {
            BlisDebug.Error(`Can't find Entity named: ${entityName}`);
            return null;
        }
        
        // If no value given, wipe all entites from buckets
        await this.blisMemory.BotMemory.Forget(entity.entityName, value, entity.isMultivalue);
    }

    public async CopyEntityAsync(entityNameFrom : string, entityNameTo: string) : Promise<void> {
        
        let entityFrom = this.FindEntity(entityNameFrom);
        let entityTo = this.FindEntity(entityNameTo);
        
        if (!entityFrom) {
            BlisDebug.Error(`Can't find Entity named: ${entityNameFrom}`);
            return null;
        }
        if (!entityTo) {
            BlisDebug.Error(`Can't find Entity named: ${entityNameTo}`);
            return null;
        }

        if (entityFrom.isMultivalue != entityTo.isMultivalue) {
            BlisDebug.Error(`Can't copy between Bucket and Non-Bucket Entities`);
            return null;
        }

        // Clear "To" entity
        await this.blisMemory.BotMemory.Forget(entityNameTo);

        // Get value of "From" entity
        let values = await this.blisMemory.BotMemory.ValueAsList(entityNameFrom);

        // Copy values from "From"
        for (let value of values) {
            await this.RememberEntityAsync(entityNameTo, value);
        }
    }

    public async EntityValueAsync(entityName : string) : Promise<string> 
    {
        return await this.blisMemory.BotMemory.Value(entityName);
    }

    public async EntityValueAsPrebuiltAsync(entityName : string) : Promise<MemoryValue[]> 
    {
        return await this.blisMemory.BotMemory.ValueAsPrebuilt(entityName);
    }

    public async EntityValueAsListAsync(entityName : string) : Promise<string[]> 
    {
        return await this.blisMemory.BotMemory.ValueAsList(entityName);
    }

    public async GetFilledEntitiesAsync() : Promise<FilledEntity[]> {
        return await this.blisMemory.BotMemory.FilledEntities();
    }

    public async AppNameAsync() : Promise<string> {
        let app = await this.blisMemory.BotState.AppAsync();
        return app.appName;
    }
}    