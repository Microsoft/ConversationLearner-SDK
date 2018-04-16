import * as BB from 'botbuilder'
import { CLMemory } from './CLMemory'

export class CLContext {
  //LARS - don't this this was ever used -  public botContext: BotContext
    public userAddress: BB.ChannelAccount
    private memory: CLMemory

    private constructor(userAddress: BB.ChannelAccount) {
        this.userAddress = userAddress
    }

    public static async CreateAsync(userAddress: BB.ChannelAccount, conversationReference: Partial<BB.ConversationReference>) {
        let context = new CLContext(userAddress)
        context.memory = await CLMemory.InitMemory(userAddress, conversationReference)
        return context
    }

    public Address(): BB.ChannelAccount | undefined {
        return this.userAddress
    }

    public Memory(): CLMemory {
        return this.memory
    }
}
