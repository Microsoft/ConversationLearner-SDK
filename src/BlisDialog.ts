import * as builder from 'botbuilder';
import { ActionTypes, UserInput, PredictedEntity, 
    ScoreInput, ScoredAction, EntityBase, 
    ModelUtils } from 'blis-models'
import { BlisRecognizer, IBlisResult } from './BlisRecognizer';
import { BlisDebug } from './BlisDebug';
import { Utils } from './Utils';
import { BlisMemory } from './BlisMemory';
import { BlisClient } from './BlisClient';
import { BlisContext} from './BlisContext';
import { ClientMemoryManager} from './Memory/ClientMemoryManager';
import { Server } from './Http/Server';
import { AzureFunctions } from './AzureFunctions';
import { InitDOLRunner } from './DOLRunner';

export const BLIS_INTENT_WRAPPER = "BLIS_INTENT_WRAPPER";

export interface IBlisOptions extends builder.IIntentRecognizerSetOptions {
    // URL for BLIS service
    serviceUri: string;

    // BLIS User Name
    user: string;

    // BLIS Secret
    secret: string;

    // Application to start
    appId: string;

    redisServer: string;

    redisKey: string;

    // End point for Azure function calls
    azureFunctionsUrl? : string;

    // Key for Azure function calls (optional)
    azureFunctionsKey? : string;

    // Optional connector, required for downloading train dialogs
    connector? : builder.ChatConnector;

    // Running on localhost
    localhost? : boolean;
}

export class BlisDialog extends builder.Dialog {

    public static dialog : BlisDialog;

    // Mapping between user defined API names and functions
    public static apiCallbacks : { string : (memoryManager: ClientMemoryManager, args : any[]) => void } | {} = {};

    // Optional callback than runs after LUIS but before BLIS.  Allows Bot to substitute entities
    public static luisCallback : (text: string, predictedEntities : PredictedEntity[], memoryManager : ClientMemoryManager) => ScoreInput;
    
    // Optional callback that runs after BLIS is called but before the Action is rendered
    public static blisCallback : (text : string, memoryManager : ClientMemoryManager) => string | builder.Message;
     
    // Create singleton
    public static Init(bot : builder.UniversalBot, options: IBlisOptions) : BlisDialog
    {
        BlisDialog.dialog = new BlisDialog(bot, options);
        return BlisDialog.dialog;
    }

    public static get Instance() : BlisDialog
    {
        return this.dialog;
    }
    
    private options: IBlisOptions;
    private blisRecognizer : BlisRecognizer;
    private recognizers: builder.IntentRecognizerSet;

    private constructor(private bot : builder.UniversalBot, options: IBlisOptions) {
        super();

        try {
            BlisDebug.InitLogger(bot)
            
            this.options = options;
            this.blisRecognizer = new BlisRecognizer();
            this.recognizers = new builder.IntentRecognizerSet({ recognizers: [this.blisRecognizer]});

            BlisDebug.Log("Creating client....");
            BlisClient.SetServiceURI(options.serviceUri);
            BlisClient.Init(options.user, options.secret, options.azureFunctionsUrl, options.azureFunctionsKey);
            BlisMemory.Init(options.redisServer, options.redisKey);

            // If app not set, assume running on localhost init DOL Runner
            if (this.options.localhost) {
                InitDOLRunner();
            }

            Server.Init();

            BlisDebug.Log("Initialization complete....");
        }
        catch (error) {
            BlisDebug.Error(error, "Dialog Constructor");
        }
    }
    
    /** Called when a new reply message has been received from a user. */
    public async replyReceived(session: builder.Session, recognizeResult?: builder.IIntentRecognizerResult): Promise<void> 
    {
        if (!recognizeResult) {
            var context = <builder.IRecognizeDialogContext>session.toRecognizeContext();
            context.dialogData = session.dialogData;
            context.activeDialog = true;
            this.recognize(context, (error, result) => {
                    var blisResult = result as IBlisResult;
                    try {
                        if (!error) {
                            this.invokeAnswer(session, blisResult);
                        }
                    } catch (e) {
                        this.emitError(session, e);
                    }
                }
            );
        } else {
            this.invokeAnswer(session, recognizeResult);
        }
    }

    /** Parses the users utterance and assigns a score from 0.0 - 1.0 indicating
     * how confident the dialog is that it understood the users utterance.  */
    public recognize(context: builder.IRecognizeContext, cb: (error: Error, result: IBlisResult) => void): void {
        this.recognizers.recognize(context, cb);
    }

    public recognizer(plugin: builder.IIntentRecognizer): this {
        // Append recognizer
        this.recognizers.recognizer(plugin);
        return this;
    }

    private invokeAnswer(session: builder.Session, recognizeResult: builder.IIntentRecognizerResult): void {

         this.ProcessInput(session, async () => {
         });
        
    }

    private validationError() : string {
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

    private async StartSessionAsync(session: builder.Session, memory: BlisMemory, appId: string): Promise<string> {

        let sessionResponse = await BlisClient.client.StartSession(appId);
        await memory.StartSessionAsync(sessionResponse.sessionId, session.message.address.conversation.id, false);
        BlisDebug.Verbose(`Started Session: ${sessionResponse.sessionId} - ${session.message.address.conversation.id}`);
        return sessionResponse.sessionId;
    }

    private async ProcessInput(session: builder.Session, cb : () => void) : Promise<void>
    {
        let errComponent = "ProcessInput";
        let memory: BlisMemory = null;
        try {
            BlisDebug.Verbose(`Process Input...`);
            let context = await BlisContext.CreateAsync(this.bot, session);

            memory = context.Memory();

            // Validate setup
            let validationError = this.validationError();
            if (validationError) {
                BlisDebug.Error(validationError);
                await Utils.SendMessage(this.bot, memory, validationError);
                return;
            }

            let inTeach = await memory.BotState.InTeachAsync();
            let app = await memory.BotState.AppAsync();
            let sessionId = null;

            // If I don't have an app yet, or app does not match
            if (!app || (this.options.appId && app.appId !== this.options.appId)) {
                if (this.options.appId) {
                    BlisDebug.Log(`Selecting app: ${this.options.appId}`);
                    app = await BlisClient.client.GetApp(this.options.appId, null);
                    await memory.BotState.SetAppAsync(app);
                }
                else {
                    throw "BLIS AppID not specified"
                }
            } 
            else {
                // Attempt to load the session
                sessionId = await memory.BotState.SessionIdAsync(session.message.address.conversation.id);
            }

            // If no session for this conversation (or it's expired), create a new one
            if (!sessionId) {
                sessionId = await this.StartSessionAsync(session, memory, app.appId);
            }

            let userInput = new UserInput({text: session.message.text});

            // Teach inputs are handled via API calls from the BLIS api
            if (!inTeach)
            {
                // Call the entity extractor
                errComponent = "SessionExtract";
                let extractResponse = await BlisClient.client.SessionExtract(app.appId, sessionId, userInput);

                errComponent = "ProcessExtraction";
                await this.ProcessExtraction(app.appId, sessionId, memory, extractResponse.text, extractResponse.predictedEntities, extractResponse.definitions.entities); 
            }
        }
        catch (error) {
            // Session is invalid
            if (memory) {
                BlisDebug.Verbose("ProcessInput Failure. Clearing Session");
                memory.EndSession();
            }
            let msg = BlisDebug.Error(error, errComponent);
            await Utils.SendMessage(this.bot, memory, msg);
        }
    }

    private async ProcessExtraction(appId : string, sessionId : string, memory : BlisMemory, text : string, predictedEntities : PredictedEntity[], allEntities : EntityBase[])
    {
            // Call LUIS callback
            let scoreInput = await this.CallLuisCallback(text, predictedEntities, memory, allEntities);
            
            // Call the scorer
            let scoreResponse = await BlisClient.client.SessionScore(appId, sessionId, scoreInput);

            // Get best action
            let bestAction = scoreResponse.scoredActions[0];

            // Take the action
            if (bestAction)
            {
                this.TakeAction(bestAction, memory, allEntities);
 
                // If action isn't terminal loop through another time
                if (!bestAction.isTerminal)
                {
                    await this.ProcessExtraction(appId, sessionId, memory, "", [], allEntities);
                }
            }
    }

    public async TakeAction(scoredAction : ScoredAction, memory : BlisMemory, allEntities : EntityBase[]) : Promise<void>
    {
        let actionType = scoredAction.metadata.actionType;

        switch (actionType)  {
            case ActionTypes.TEXT:
                await this.TakeTextAction(scoredAction, memory, allEntities);
                break;
            case ActionTypes.CARD:
                await this.TakeCardAction(scoredAction, memory, allEntities);
                break;
            case ActionTypes.INTENT:
                await this.TakeIntentAction(scoredAction, memory, allEntities);
                break;
            case ActionTypes.API_AZURE:
                await this.TakeAzureAPIAction(scoredAction, memory, allEntities);
                break;
            case ActionTypes.API_LOCAL:
                await this.TakeLocalAPIAction(scoredAction, memory, allEntities);
                break;
        }
    }

    private async TakeTextAction(scoredAction : ScoredAction, memory : BlisMemory, allEntities : EntityBase[]) : Promise<void>
    {
        let outText = await this.CallBlisCallback(scoredAction, memory, allEntities);
        await Utils.SendMessage(this.bot, memory, outText);
    }

    private async TakeCardAction(scoredAction : ScoredAction, memory : BlisMemory, allEntities : EntityBase[]) : Promise<void>
    {
        //TODO
    }

    private async TakeLocalAPIAction(scoredAction : ScoredAction, memory : BlisMemory, allEntities : EntityBase[]) : Promise<void>
    {
        if (!BlisDialog.apiCallbacks)
        {
            BlisDebug.Error("No Local APIs defined.")
            return;
        }

        // Extract API name and args
        let apiName = ModelUtils.GetPrimaryPayload(scoredAction);
        let args = ModelUtils.GetArguments(scoredAction);

        // Make any entity substitutions
        let argArray = [];
        for (let arg of args)
        {
            argArray.push(await memory.BotMemory.SubstituteEntities(arg));
        }

        let api = BlisDialog.apiCallbacks[apiName];
        if (!api)
        {
            let msg = BlisDebug.Error(`API "${apiName}" is undefined`);
            throw msg;
        }

        let memoryManager = new ClientMemoryManager(memory, allEntities);
        
        let output = await api(memoryManager, argArray);
        if (output)
        {
            await Utils.SendMessage(this.bot, memory, output);
        }  
    }

    private async TakeAzureAPIAction(scoredAction : ScoredAction, memory : BlisMemory, allEntities : EntityBase[]) : Promise<void>
    {
        // Extract API name and entities
        let apiString = scoredAction.payload;
        let [funcName] = apiString.split(' ');
        let args = ModelUtils.RemoveWords(apiString, 1);

        // Make any entity substitutions
        let entities = await memory.BotMemory.SubstituteEntities(args);

        // Call Azure function and send output (if any)
        let output = await AzureFunctions.Call(BlisClient.client.azureFunctionsUrl, BlisClient.client.azureFunctionsKey, funcName, entities);
        if (output)
        {
            await Utils.SendMessage(this.bot, memory, output);
        }          
    }

    private async TakeIntentAction(scoredAction : ScoredAction, memory : BlisMemory, allEntities : EntityBase[]) : Promise<void>
    {
        // Extract intent name and entities
        let apiString = scoredAction.payload;
        let [intentName] = apiString.split(' ');
        let args = ModelUtils.RemoveWords(apiString, 1);

        // Make any entity substitutions
        let entities = await memory.BotMemory.GetEntities(args);
        let session = await memory.BotState.SessionAsync(this.bot);

        // If in teach mode wrap the intent so can give next input cue when intent dialog completes
        let inTeach = await memory.BotState.InTeachAsync();
        if (inTeach)
        {
            session.beginDialog(BLIS_INTENT_WRAPPER, {intent: intentName, entities: entities});
        }
        else
        {
            session.beginDialog(intentName, entities);
        }                
    }

    public async CallLuisCallback(text: string, predictedEntities : PredictedEntity[], memory : BlisMemory, allEntities : EntityBase[]) : Promise<ScoreInput> {

        let memoryManager = new ClientMemoryManager(memory, allEntities);

        let scoreInput = null;
        if (BlisDialog.luisCallback) {
            scoreInput = await BlisDialog.luisCallback(text, predictedEntities, memoryManager);
        }
        else {
            scoreInput = await this.DefaultLuisCallback(text, predictedEntities, memoryManager);
        }
        return scoreInput;
    }

    private async CallBlisCallback(scoredAction : ScoredAction, memory : BlisMemory, allEntities : EntityBase[]) : Promise<string | builder.Message> {

        let memoryManager = new ClientMemoryManager(memory, allEntities);

        let outText = null;
        if (BlisDialog.luisCallback) {
            outText = await BlisDialog.blisCallback(scoredAction.payload, memoryManager);
        }
        else {
            outText = await this.DefaultBlisCallback(scoredAction.payload, memoryManager);
        }
        return outText;
    }

    public async DefaultLuisCallback(text: string, predictedEntities : PredictedEntity[], memoryManager : ClientMemoryManager) : Promise<ScoreInput>
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

        // Get entities from my memory
        var filledEntities = await memoryManager.blisMemory.BotMemory.FilledEntities();

        let scoreInput = new ScoreInput({   
            filledEntities: filledEntities,
            context: {},
            maskedActions: []
        });
        return scoreInput;
    }

    private async DefaultBlisCallback(text: string, memoryManager : ClientMemoryManager) : Promise<string>
    {
        let outText = await memoryManager.blisMemory.BotMemory.Substitute(text);
        return outText;
    }


	private emitError(session: builder.Session, err: Error): void {
		var m = err.toString();
		err = err instanceof Error ? err : new Error(m);
		session.error(err);
	}
}