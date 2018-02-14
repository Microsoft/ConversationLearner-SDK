import * as BB from 'botbuilder';
import { BlisRecognizer } from './BlisRecognizer';
import { BlisTemplateRenderer } from './BlisTemplateRenderer';
import { IBlisOptions } from './BlisOptions';
import { BlisMemory } from './BlisMemory';
import { BlisDebug } from './BlisDebug';
import { BlisClient } from './BlisClient';
import { Server } from './Http/Server';
import { InitDOLRunner } from './DOLRunner';
import { TemplateProvider } from './TemplateProvider';
import { AzureFunctions } from './AzureFunctions';
import { Utils } from './Utils';
import { EntityBase, PredictedEntity, EntityList, TrainDialog, TrainRound,
        ActionPayload, SenderType, ActionTypes, ScoredAction, Memory,
        ScoreInput, ModelUtils, ActionBase, CallbackAPI, FilledEntity, FilledEntityMap, TeachWithHistory, DialogMode, getActionArgumentValueAsPlainText, filledEntityValueAsString } from 'blis-models'
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
    public static templateRenderer: BlisTemplateRenderer;

    public static Init(options: IBlisOptions, storage: BB.Storage = null) {

        Blis.options = options;

        try {
            BlisDebug.Log("Creating client....");
            BlisClient.SetServiceURI(options.serviceUri);
            BlisClient.Init(options.user, options.secret, options.azureFunctionsUrl, options.azureFunctionsKey);
            BlisMemory.Init(storage);

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
        Blis.templateRenderer = new BlisTemplateRenderer();
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
        Blis.apiParams.push({ name, arguments: this.GetArguments(target) })
    }
    
    public static EntityDetectionCallback(target : (text: string, predictedEntities : PredictedEntity[], memoryManager : ClientMemoryManager) => Promise<void>)
    {
        Blis.entityDetectionCallback = target;
    }
    
    public static async SendIntent(memory: BlisMemory, intent: BlisIntent) : Promise<void> {
        await Utils.SendIntent(Blis.bot, memory, intent);
    }

    public static async SendMessage(memory: BlisMemory, content: string | BB.Activity) : Promise<void> {
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
        
        let scoreInput: ScoreInput = {   
            filledEntities,
            context: {},
            maskedActions: []
        };
        return scoreInput;
    }
    
    public static async ProcessPredictedEntities(text: string, predictedEntities : PredictedEntity[], memoryManager : ClientMemoryManager) : Promise<void>
    {
        for (var predictedEntity of predictedEntities)
        // Update entities in my memory
        {
            let entity = memoryManager.FindEntityById(predictedEntity.entityId);

            // If negative entity will have a positive counter entity
            if (entity.positiveId)
            {
                await memoryManager.blisMemory.BotMemory.ForgetEntity(entity.entityName, predictedEntity.entityText, entity.isMultivalue);
            }
            else
            {
                await memoryManager.blisMemory.BotMemory.RememberEntity(
                    entity.entityName,
                    entity.entityId,
                    predictedEntity.entityText,
                    entity.isMultivalue,
                    predictedEntity.builtinType,
                    predictedEntity.resolution
                );
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
        const apiName = actionPayload.payload;
        const argArray = actionPayload.arguments
            .map(a => filledEntityMap.SubstituteEntities(getActionArgumentValueAsPlainText(a)))

        const api = Blis.apiCallbacks[apiName];
        if (!api)
        {
            return BlisDebug.Error(`API "${apiName}" is undefined`);
        }

        let memoryManager = new ClientMemoryManager(memory, allEntities);
        
        return await api(memoryManager, ...argArray.reverse()); 
    }

    public static async TakeTextAction(action: ActionBase | ScoredAction, filledEntityMap : FilledEntityMap) : Promise<Partial<BB.Activity> | string | undefined>
    {
        return await filledEntityMap.Substitute(ActionBase.GetPayload(action))
    }
     
    public static async TakeCardAction(action: ActionBase | ScoredAction, filledEntityMap : FilledEntityMap) : Promise<Partial<BB.Activity> | string | undefined>
    {
        let actionPayload = JSON.parse(action.payload) as ActionPayload;
        
        try {
            let form = await TemplateProvider.RenderTemplate(actionPayload, filledEntityMap);
            if (form == null) {
                return BlisDebug.Error(`Missing Template: ${actionPayload.payload}`);
            }
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

    // Validate that training round memory is the same as what in the bot's memory
    // This checks that API calls didn't change when restoring the bot's state
    private static IsSame(round: TrainRound, memory: BlisMemory, entities: EntityBase[]) : string[] {
        let isSame = true;
        let oldEntities = (round.scorerSteps[0] && round.scorerSteps[0].input) ? round.scorerSteps[0].input.filledEntities : [];
        let newEntities = Object.keys(memory.BotMemory.filledEntities.map).map(k => memory.BotMemory.filledEntities.map[k] as FilledEntity);

        if (oldEntities.length != newEntities.length) {
            isSame = false;
        }
        else {
                for (let oldEntity of oldEntities) {
                let newEntity = newEntities.find(ne => ne.entityId == oldEntity.entityId);
                if (!newEntity) {
                    isSame = false;
                }
                else if (oldEntity.values.length != newEntity.values.length) {
                    isSame = false;
                }
                else {
                    for (let oldValue of oldEntity.values) {
                        let newValue = newEntity.values.find(v => v.userText == oldValue.userText);
                        if (!newValue) {
                            isSame = false;
                        }
                        if (oldValue.userText !== newValue.userText) {
                            isSame = false;
                        }
                    }
                }
            }
        }
        if (isSame) { 
            return [];
        }
        let discrepancies = [];
        discrepancies.push('Original Entities:');
        for (let oldEntity of oldEntities)
        {
            let name = entities.find(e => e.entityId == oldEntity.entityId).entityName;
            let values = filledEntityValueAsString(oldEntity);
            discrepancies.push(`${name} = (${values})`);
        }
        discrepancies.push('','New Entities:');
        for (let newEntity of newEntities)
        {
            let name = entities.find(e => e.entityId == newEntity.entityId).entityName;
            let values = filledEntityValueAsString(newEntity);
            discrepancies.push(`${name} = (${values})`);
        }
        return discrepancies;
    }
    
    // LARS - temp. move to shared utils after branch merge
    private static generateGUID(): string {
        let d = new Date().getTime();
        let guid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
            let r = (d + Math.random() * 16) % 16 | 0;
            d = Math.floor(d / 16);
            return (char == 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
        return guid;
    }

    /** Get Activites generated by trainDialog.  If "updateBotState" is set, will also update bot state to 
     * what it was at the end of playing back the trainDialog
     */
    public static async GetHistory(appId: string, trainDialog: TrainDialog, userName: string, userId: string, memory: BlisMemory, updateBotState: boolean = false, ignoreLastExtract: boolean = false) : Promise<TeachWithHistory> {

        let entities = trainDialog.definitions.entities;
        let actions = trainDialog.definitions.actions;
        let entityList: EntityList = { entities }
        let prevMemories: Memory[] = []

        // Reset the memory
        if (updateBotState) {
            await memory.BotMemory.ClearAsync();
        }

        if (!trainDialog || !trainDialog.rounds) {
            return null;
        }

        let activities = [];
        let discrepancies: string[] = [];
        let roundNum = 0;
        let isLastActionTerminal = false;
        for (let round of trainDialog.rounds) {
            let userText = round.extractorStep.textVariations[0].text;
            let userActivity = { 
                id: this.generateGUID(), 
                from: { id: userId, name: userName }, 
                channelData: {senderType: SenderType.User, roundIndex: roundNum, scoreIndex: 0, clientActivityId: this.generateGUID()},
                type: 'message', 
                text: userText } as BB.Activity;
            activities.push(userActivity);

            // If I'm updating the bot's state (rather than just returning activities)
            if (updateBotState) {
                // If I'm updating the bot's state, save memory before this step (used to show changes in UI)
                prevMemories = await memory.BotMemory.DumpMemory();
                                    
                // Call entity detection callback
                let textVariation = round.extractorStep.textVariations[0];
                let predictedEntities = ModelUtils.ToPredictedEntities(textVariation.labelEntities);
                await Blis.CallEntityDetectionCallback(textVariation.text, predictedEntities, memory, entities);

                // Look for discrenancies when replaying API calls
                // Unless asked to ignore the last as user trigged an edit by editing last extract step
                if (!ignoreLastExtract || (roundNum != trainDialog.rounds.length-1)) {
                    discrepancies = this.IsSame(round, memory, entities);
                    if (discrepancies.length > 0) {
                        discrepancies = [``,`User Input Step:`,`${userText}`,``,...discrepancies];
                        break;
                    }
                }
            }

            let scoreNum = 0;
            for (let scorerStep of round.scorerSteps) {
                let labelAction = scorerStep.labelAction;
                let action = actions.filter((a: ActionBase) => a.actionId === labelAction)[0];

                if (!action) {
                    throw new Error(`Can't find Entity Id ${labelAction}`);
                }
                isLastActionTerminal = action.isTerminal;

                let filledEntityMap = this.CreateFilledEntityMap(scorerStep.input.filledEntities, entityList);

                let channelData = {senderType: SenderType.Bot, roundIndex: roundNum, scoreIndex: scoreNum};
                let botResponse = null;
                if (action.actionType === ActionTypes.CARD) {
                    botResponse = await this.TakeCardAction(action, filledEntityMap);
                } else if (action.actionType === ActionTypes.API_LOCAL) {
                    botResponse = await this.TakeLocalAPIAction(action, filledEntityMap, memory, entityList.entities);                    
                }  else {
                    botResponse = await Blis.TakeTextAction(action, filledEntityMap);  
                }
                // TODO 
                //  TakeAzureAPIAction
                
                let botActivity : BB.Activity = null;
                if (typeof botResponse == 'string')
                {
                    botActivity = { 
                        id: this.generateGUID(), 
                        from: { id: 'BlisTrainer', name: 'BlisTrainer' }, 
                        type: 'message', text: botResponse,
                        channelData: channelData
                    };
                }
                else if (botResponse) {
                    botActivity = botResponse as BB.Activity;
                    botActivity.id = this.generateGUID();
                    botActivity.from = { id: 'BlisTrainer', name: 'BlisTrainer' };
                    botActivity.channelData = channelData;
                }
 
                if (botActivity) {
                    activities.push(botActivity);
                }
                scoreNum++;
            }
            roundNum++;
        }


        let memories = null;
        if (updateBotState) {
           memories = await memory.BotMemory.DumpMemory();
        }
        
        let teachWithHistory: TeachWithHistory = {
            teach: undefined,
            scoreInput: undefined,
            scoreResponse: undefined,
            history: activities,
            memories: memories,
            prevMemories: prevMemories,
            dialogMode: isLastActionTerminal ? DialogMode.Wait : DialogMode.Scorer,
            discrepancies: discrepancies
        }
        return teachWithHistory;
    }
    
    public static ValidationErrors() : string {
        let errMsg = "";
        if (!this.options.serviceUri) {
            errMsg += "Options missing serviceUrl. Set BLIS_SERVICE_URI Env value.\n\n";
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