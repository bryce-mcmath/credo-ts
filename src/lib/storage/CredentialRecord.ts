import { v4 as uuid } from 'uuid';
import { BaseRecord, RecordType } from './BaseRecord';
import { CredentialOfferMessage } from '../protocols/credentials/messages/CredentialOfferMessage';
import { CredentialState } from '../protocols/credentials/CredentialState';

export interface CredentialStorageProps {
  id?: string;
  offer: CredentialOfferMessage;
  state: CredentialState;
}

export class CredentialRecord extends BaseRecord implements CredentialStorageProps {
  public offer: CredentialOfferMessage;

  public type = RecordType.CredentialRecord;
  public static type: RecordType = RecordType.CredentialRecord;

  public state: CredentialState;

  public constructor(props: CredentialStorageProps) {
    super(props.id ? props.id : uuid());
    this.offer = props.offer;
    this.state = props.state;
  }
}