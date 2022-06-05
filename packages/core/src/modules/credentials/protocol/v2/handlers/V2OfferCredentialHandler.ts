import type { AgentConfig } from '../../../../../agent/AgentConfig'
import type { Handler, HandlerInboundMessage } from '../../../../../agent/Handler'
import type { InboundMessageContext } from '../../../../../agent/models/InboundMessageContext'
import type { DidCommMessageRepository } from '../../../../../storage'
import type { DidResolverService } from '../../../../dids'
import type { MediationRecipientService } from '../../../../routing/services/MediationRecipientService'
import type { CredentialExchangeRecord } from '../../../repository/CredentialExchangeRecord'
import type { V2CredentialService } from '../V2CredentialService'

import { createOutboundMessage, createOutboundServiceMessage } from '../../../../../agent/helpers'
import { ServiceDecorator } from '../../../../../decorators/service/ServiceDecorator'
import { AriesFrameworkError } from '../../../../../error/AriesFrameworkError'
import { DidCommMessageRole } from '../../../../../storage'
import { getIndyDidFromVerificationMethod } from '../../../../../utils/did'
import { findVerificationMethodByKeyType } from '../../../../dids'
import { V2OfferCredentialMessage } from '../messages/V2OfferCredentialMessage'
import { V2ProposeCredentialMessage } from '../messages/V2ProposeCredentialMessage'

export class V2OfferCredentialHandler implements Handler {
  private credentialService: V2CredentialService
  private agentConfig: AgentConfig
  private mediationRecipientService: MediationRecipientService
  public supportedMessages = [V2OfferCredentialMessage]
  private didCommMessageRepository: DidCommMessageRepository
  private didResolver: DidResolverService

  public constructor(
    credentialService: V2CredentialService,
    agentConfig: AgentConfig,
    mediationRecipientService: MediationRecipientService,
    didCommMessageRepository: DidCommMessageRepository,
    didResolver: DidResolverService
  ) {
    this.credentialService = credentialService
    this.agentConfig = agentConfig
    this.mediationRecipientService = mediationRecipientService
    this.didCommMessageRepository = didCommMessageRepository
    this.didResolver = didResolver
  }

  public async handle(messageContext: InboundMessageContext<V2OfferCredentialMessage>) {
    const credentialRecord = await this.credentialService.processOffer(messageContext)

    const offerMessage = await this.didCommMessageRepository.findAgentMessage({
      associatedRecordId: credentialRecord.id,
      messageClass: V2OfferCredentialMessage,
    })

    const proposeMessage = await this.didCommMessageRepository.findAgentMessage({
      associatedRecordId: credentialRecord.id,
      messageClass: V2ProposeCredentialMessage,
    })

    if (!offerMessage) {
      throw new AriesFrameworkError('Missing offer message in V2OfferCredentialHandler')
    }

    const shouldAutoRespond = this.credentialService.shouldAutoRespondToOffer(
      credentialRecord,
      offerMessage,
      proposeMessage ?? undefined
    )

    if (shouldAutoRespond) {
      return await this.createRequest(credentialRecord, messageContext, offerMessage)
    }
  }

  private async createRequest(
    record: CredentialExchangeRecord,
    messageContext: HandlerInboundMessage<V2OfferCredentialHandler>,
    offerMessage?: V2OfferCredentialMessage
  ) {
    this.agentConfig.logger.info(
      `Automatically sending request with autoAccept on ${this.agentConfig.autoAcceptCredentials}`
    )

    if (messageContext.connection) {
      if (!messageContext.connection.did) {
        throw new AriesFrameworkError(`Connection record ${messageContext.connection.id} has no 'did'`)
      }

      const didDocument = await this.didResolver.resolveDidDocument(messageContext.connection.did)

      const verificationMethod = await findVerificationMethodByKeyType('Ed25519VerificationKey2018', didDocument)
      if (!verificationMethod) {
        throw new AriesFrameworkError(
          'Invalid DidDocument: Missing verification method with type Ed25519VerificationKey2018 to use as indy holder did'
        )
      }
      const indyDid = getIndyDidFromVerificationMethod(verificationMethod)
      const { message, credentialRecord } = await this.credentialService.createRequest(record, {
        holderDid: indyDid,
      })
      await this.didCommMessageRepository.saveAgentMessage({
        agentMessage: message,
        role: DidCommMessageRole.Receiver,
        associatedRecordId: credentialRecord.id,
      })
      return createOutboundMessage(messageContext.connection, message)
    } else if (offerMessage?.service) {
      const routing = await this.mediationRecipientService.getRouting()
      const ourService = new ServiceDecorator({
        serviceEndpoint: routing.endpoints[0],
        recipientKeys: [routing.recipientKey.publicKeyBase58],
        routingKeys: routing.routingKeys.map((key) => key.publicKeyBase58),
      })
      const recipientService = offerMessage.service

      const { message, credentialRecord } = await this.credentialService.createRequest(record, {
        holderDid: ourService.recipientKeys[0],
      })

      // Set and save ~service decorator to record (to remember our verkey)
      message.service = ourService

      await this.credentialService.update(credentialRecord)
      await this.didCommMessageRepository.saveAgentMessage({
        agentMessage: message,
        role: DidCommMessageRole.Sender,
        associatedRecordId: credentialRecord.id,
      })
      return createOutboundServiceMessage({
        payload: message,
        service: recipientService.resolvedDidCommService,
        senderKey: ourService.resolvedDidCommService.recipientKeys[0],
      })
    }

    this.agentConfig.logger.error(`Could not automatically create credential request`)
  }
}