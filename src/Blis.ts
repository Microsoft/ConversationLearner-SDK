import * as BB from 'botbuilder-core';
import { BlisRecognizer } from './BlisRecognizer';
import { BlisTemplateManager } from './BlisTemplateManager';
import { IBlisOptions } from './BlisOptions';
import { BlisMemory } from './BlisMemory';
import { BlisDebug } from './BlisDebug';
import { BlisClient } from './BlisClient';
import { Server } from './Http/Server';
import { InitDOLRunner } from './DOLRunner';
import { TemplateProvider } from './TemplateProvider';
import { AzureFunctions } from './AzureFunctions';
import { Utils } from './Utils';
import { EntityBase, PredictedEntity, EntityList, TrainDialog,
        ActionPayload, SenderType, ActionTypes, ScoredAction,
        ScoreInput, ModelUtils, ActionBase, CallbackAPI, FilledEntity, FilledEntityMap } from 'blis-models'
import { ClientMemoryManager} from './Memory/ClientMemoryManager';
import { BlisIntent } from './BlisIntent';

export class Blis  {

    public static options: IBlisOptions;

    // Mapping between user defined API names and functions
    public static apiCallbacks : { string : (memoryManager: ClientMemoryManager, ...args : string[]) => Promise<BB.Activity | string | undefined> } | {} = {};
    public static apiParams : CallbackAPI[] = [];
      
    // Optional callback than runs after LUIS but before BLIS.  Allows Bot to substitute entities
    public static entityDetectionCallback : (text: string, predictedEntities : PredictedEntity[], memoryManager : ClientMemoryManager) => Promise<void>;
    
    public static bot: BB.Bot;
    public static recognizer : BlisRecognizer;
    public static templateManager : BlisTemplateManager;

    public static Init(options: IBlisOptions) {

        Blis.options = options;

        try {
            BlisDebug.Log("Creating client....");
            BlisClient.SetServiceURI(options.serviceUri);
            BlisClient.Init(options.user, options.secret, options.azureFunctionsUrl, options.azureFunctionsKey);
            BlisMemory.Init(options.redisServer, options.redisKey);

            // If app not set, assume running on localhost init DOL Runner
            if (options.localhost) {
                InitDOLRunner();
            }

            Server.Init();

            BlisDebug.Log("Initialization complete....");
        }
        catch (error) {
            BlisDebug.Error(error, "Dialog Constructor");
        }

        Blis.recognizer = new BlisRecognizer(options);
        Blis.templateManager = new BlisTemplateManager();
    }

    public static SetBot(botContext : BotContext) {
        if (!Blis.bot) {  
            Blis.bot = botContext.bot;
            BlisDebug.InitLogger(botContext);
        }
    }

    public static AddAPICallback(name: string, target : (memoryManager: ClientMemoryManager, ...args : string[]) => Promise<BB.Activity | string | undefined>)
    {
        Blis.apiCallbacks[name] = target;
        Blis.apiParams.push(new CallbackAPI({name: name, arguments: this.GetArguments(target)}));
    }
    
    public static EntityDetectionCallback(target : (text: string, predictedEntities : PredictedEntity[], memoryManager : ClientMemoryManager) => Promise<void>)
    {
        Blis.entityDetectionCallback = target;
    }
    
    public static async SendIntent(memory: BlisMemory, intent: BlisIntent) : Promise<void> {
        await Utils.SendIntent(Blis.bot, memory, intent);
    }

    public static async SendMessage(memory: BlisMemory, content: string) : Promise<void> {
        await Utils.SendMessage(Blis.bot, memory, content);
    }

    public static async CallEntityDetectionCallback(text: string, predictedEntities : PredictedEntity[], memory : BlisMemory, allEntities : EntityBase[]) : Promise<ScoreInput> {
    
        let memoryManager = new ClientMemoryManager(memory, allEntities);

        // Update memory with predicted entities
        await Blis.ProcessPredictedEntities(text, predictedEntities, memoryManager);

        // If bot has callback, call it
        if (Blis.entityDetectionCallback) {
            await Blis.entityDetectionCallback(text, predictedEntities, memoryManager);
        }

        // Get entities from my memory
        var filledEntities = await memoryManager.blisMemory.BotMemory.FilledEntities();
        
        let scoreInput = new ScoreInput({   
            filledEntities: filledEntities,
            context: {},
            maskedActions: []
        });
        return scoreInput;
    }
    
    public static async ProcessPredictedEntities(text: string, predictedEntities : PredictedEntity[], memoryManager : ClientMemoryManager) : Promise<void>
    {
        for (var predictedEntity of predictedEntities)
        // Update entities in my memory
        {
            // If negative entity will have a positive counter entity
            if (predictedEntity.metadata && predictedEntity.metadata.positiveId)
            {
                await memoryManager.blisMemory.BotMemory.ForgetEntity(predictedEntity);
            }
            else
            {
                await memoryManager.blisMemory.BotMemory.RememberEntity(predictedEntity);
            }

            // If entity is associated with a task, make sure task is active
            /*
            if (predictedEntity.metadata && predictedEntity.metadata.task)
            {
                // If task is no longer active, clear the memory
                let remembered = await memory.BotMemory.WasRemembered(predictedEntity.metadata.task);
                if (!remembered)
                {
                    await memory.BotMemory.ForgetByLabel(predictedEntity);
                }
            }
            */
        }
    }

    public static async TakeLocalAPIAction(action: ActionBase | ScoredAction, filledEntityMap : FilledEntityMap, memory : BlisMemory, allEntities : EntityBase[]) : Promise<Partial<BB.Activity> | string | undefined>
    {
        let actionPayload = JSON.parse(action.payload) as ActionPayload;
        if (!Blis.apiCallbacks)
        {
            BlisDebug.Error("No Local APIs defined.")
            return undefined;
        }

        // Extract API name and args
        let apiName = actionPayload.payload;
        let args = ActionPayload.GetArguments(actionPayload);

        // Make any entity substitutions
        let argArray = [];
        for (let arg of args)
        {
            argArray.push(filledEntityMap.SubstituteEntities(arg));
        }

        let api = Blis.apiCallbacks[apiName];
        if (!api)
        {
            let msg = BlisDebug.Error(`API "${apiName}" is undefined`);
            throw msg;
        }

        let memoryManager = new ClientMemoryManager(memory, allEntities);
        
        return await api(memoryManager, ...argArray.reverse()); 
    }

    public static async TakeTextAction(action: ActionBase | ScoredAction, filledEntityMap : FilledEntityMap) : Promise<Partial<BB.Activity> | string | undefined>
    {
        let outText = await filledEntityMap.Substitute(action.payload);
        return outText;
    }
     
    public static async TakeCardAction(action: ActionBase | ScoredAction, filledEntityMap : FilledEntityMap) : Promise<Partial<BB.Activity> | string | undefined>
    {
        let actionPayload = JSON.parse(action.payload) as ActionPayload;
        
        try {
            let form = await TemplateProvider.RenderTemplate(actionPayload, filledEntityMap);
            const attachment = BB.CardStyler.adaptiveCard(form);
            const message = BB.MessageStyler.attachment(attachment);
            message.text = null;
            return message;
        }
        catch (error) {
            let msg = BlisDebug.Error(error, "Failed to Render Template");
            return msg;
        }
    }

    public static async TakeAzureAPIAction(actionPayload: ActionPayload, filledEntityMap : FilledEntityMap) : Promise<Partial<BB.Activity> | string | undefined>
    {
        // Extract API name and entities
        let apiString = actionPayload.payload;
        let [funcName] = apiString.split(' ');
        let args = ModelUtils.RemoveWords(apiString, 1);

        // Make any entity substitutions
        let entities = filledEntityMap.SubstituteEntities(args);

        // Call Azure function and send output (if any)
        return await AzureFunctions.Call(BlisClient.client.azureFunctionsUrl, BlisClient.client.azureFunctionsKey, funcName, entities);        
    }

    /** Convert list of filled entities into a filled entity map lookup table */
    private static CreateFilledEntityMap(filledEntities: FilledEntity[], entityList: EntityList) : FilledEntityMap {

        let filledEntityMap = new FilledEntityMap();
        for (var filledEntity of filledEntities) {
            let entity = entityList.entities.find(e => e.entityId == filledEntity.entityId);
            if (entity) {
                filledEntityMap.map[entity.entityName] = filledEntity;
            }
        }
        return filledEntityMap;
    }

    /** Get Activites generated by trainDialog.  If "updateBotState" is set, will also update bot state to 
     * what it was at the end of playing back the trainDialog
     */
    public static async GetHistory(appId: string, trainDialog: TrainDialog, userName: string, userId: string, memory: BlisMemory, updateBotState: boolean = false) : Promise<(string | BB.Activity)[]> {

        // LARSTODO - combine into single api call
        let entityList = await BlisClient.client.GetEntities(appId, null);
        let actionList = await BlisClient.client.GetActions(appId, null);
        
        if (!trainDialog || !trainDialog.rounds) {
            return [];
        }

        let activities = [];
        let roundNum = 0;
        for (let round of trainDialog.rounds) {
            let userText = round.extractorStep.textVariations[0].text;
            let id = `${SenderType.User}:${roundNum}:0`;
            let userActivity = { id: id, from: { id: userId, name: userName }, type: 'message', text: userText } as BB.Activity;
            activities.push(userActivity);

            if (updateBotState) {
                // Call entity detection callback
                let textVariation = round.extractorStep.textVariations[0];
                let predictedEntities = ModelUtils.ToPredictedEntities(textVariation.labelEntities, entityList);
                await Blis.CallEntityDetectionCallback(textVariation.text, predictedEntities, memory, entityList.entities);
            }

            let scoreNum = 0;
            for (let scorerStep of round.scorerSteps) {
                let labelAction = scorerStep.labelAction;
                let action = actionList.actions.filter((a: ActionBase) => a.actionId === labelAction)[0];

                let filledEntityMap = this.CreateFilledEntityMap(scorerStep.input.filledEntities, entityList);

                id = `${SenderType.Bot}:${roundNum}:${scoreNum}`
                let botResponse = null;
                if (action.metadata && action.metadata.actionType === ActionTypes.CARD) {
                    botResponse = await this.TakeCardAction(action, filledEntityMap);
                } else if (action.metadata && action.metadata.actionType === ActionTypes.API_LOCAL) {
                    botResponse = await this.TakeLocalAPIAction(action, filledEntityMap, memory, entityList.entities);                    
                }  else {
                    botResponse = await Blis.TakeTextAction(action, filledEntityMap);  
                }
                // TODO 
                //  TakeAzureAPIAction
                
                let botActivity : BB.Activity = null;
                if (typeof botResponse == 'string')
                {
                    botActivity = { id: id, from: { id: 'BlisTrainer', name: 'BlisTrainer' }, type: 'message', text: botResponse };
                }
                else if (botResponse) {
                    botActivity = botResponse as BB.Activity;
                    botActivity.id = id;
                    botActivity.from = { id: 'BlisTrainer', name: 'BlisTrainer' };
                }
 
                if (botActivity) {
                    activities.push(botActivity);
                }
                scoreNum++;
            }
            roundNum++;
        }
        return activities;
    }
    
    public static ValidationErrors() : string {
        let errMsg = "";
        if (!this.options.serviceUri) {
            errMsg += "Options missing serviceUrl. Set BLIS_SERVICE_URI Env value.\n\n";
        }
        if (!this.options.redisKey) {
            errMsg += "Options missing redisKey. Set BLIS_REDIS_KEY Env value.\n\n";
        }
        if (!this.options.redisServer) {
            errMsg += "Options missing redisServer. Set BLIS_REDIS_SERVER Env value.\n\n";
        }
        if (!this.options.localhost && !this.options.appId) {
            errMsg += "Options must specify appId when not running on localhost. Set BLIS_APP_ID Env value.\n\n";
        }
        return errMsg;
    }

    private static GetArguments(func : any) : string[] {

        const STRIP_COMMENTS = /(\/\/.*$)|(\/\*[\s\S]*?\*\/)|(\s*=[^,\)]*(('(?:\\'|[^'\r\n])*')|("(?:\\"|[^"\r\n])*"))|(\s*=[^,\)]*))/mg;
        const ARGUMENT_NAMES = /([^\s,]+)/g;

        var fnStr = func.toString().replace(STRIP_COMMENTS, '');
        var result = fnStr.slice(fnStr.indexOf('(')+1, fnStr.indexOf(')')).match(ARGUMENT_NAMES);
        if(result === null)
           result = [];
        return result.filter((f:string) => f !== "memoryManager");
      }
}    