// --- JSON-RPC Types ---

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
  id: string | number;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  result?: T;
  error?: JsonRpcError;
  id: string | number;
}

// --- Transaction Types ---

export interface IEphemeralKeyPair {
  privateKey: string;
  publicKey: string;
}

export enum ETransferType {
  GiveCoffee = 'give_coffee',
  TransferToken = 'transfer_token',
  UnlockItem = 'unlock_item',
}

export interface ExtraInfo {
  type: ETransferType | string;
  ItemId?: string;
  ItemType?: string;
  ClanId?: string;
  UserSenderId?: string;
  UserSenderUsername?: string;
  UserReceiverId?: string;
  ChannelId?: string;
  MessageRefId?: string;
  ExtraAttribute?: string;
  [x: string]: string;
}

export interface TxMsg {
  type: number;
  sender: string;
  recipient: string;
  amount: string;
  timestamp: number;
  text_data: string;
  nonce: number;
  extra_info: string;
  zk_proof: string;
  zk_pub: string;
}

export interface SignedTx {
  tx_msg: TxMsg;
  signature: string;
}

export interface SendTransactionBase {
  sender: string;
  recipient: string;
  amount: string;
  nonce: number;
  timestamp?: number;
  textData?: string;
  privateKey: string;
  extraInfo?: ExtraInfo;
}

export interface SendTransactionRequest extends SendTransactionBase {
  zkProof: string;
  zkPub: string;
  publicKey: string;
}

export interface AddTxResponse {
  ok: boolean;
  tx_hash: string;
  error: string;
}

export interface GetCurrentNonceResponse {
  address: string;
  nonce: number;
  tag: string;
  error: string;
}

export interface GetAccountByAddressResponse {
  address: string;
  balance: string;
  nonce: number;
  decimals: number;
}

// --- Client Configuration ---

export interface MmnClientConfig {
  baseUrl: string;
  timeout?: number;
  headers?: Record<string, string>;
}

// ----------------- Types Indexer -----------------

export interface BaseTransaction {
  chain_id: string;
  hash: string;
  nonce: number;
  block_hash: string;
  block_number: number;
  from_address: string;
  to_address: string;
  value: string; // uint256 -> string
  transaction_type: number;
  transaction_timestamp: number;
  status?: number;
  text_data?: string;
  extra_info?: string;
}
export interface EvmTransaction extends BaseTransaction {
  block_timestamp: number;
  transaction_index: number;
  gas: number;
  gas_price: string;
  data: string;
  function_selector: string;
  max_fee_per_gas: string;
  max_priority_fee_per_gas: string;
  max_fee_per_blob_gas?: string;
  effective_gas_price?: string;
  blob_versioned_hashes?: string[];
  blob_gas_used?: number;
  blob_gas_price?: string;
  r: string;
  s: string;
  v: string;
  gas_used?: number;
  cumulative_gas_used?: number;
  contract_address?: string;
  logs_bloom?: string;
  access_list_json?: string;
  authorization_list_json?: string;
}
export interface Meta {
  chain_id: number;
  address?: string;
  signature?: string;
  page: number;
  limit?: number;
  total_items?: number;
  total_pages?: number;
  has_more?: boolean;
  next_timestamp?: string;
  next_hash?: string;
}

export interface WalletDetail {
  address: string;
  balance: string;
  account_nonce: number;
  last_balance_update: number;
}

export interface WalletDetailResponse {
  data: WalletDetail;
}

export interface ListTransactionResponse {
  meta: Meta;
  data?: EvmTransaction[];
}

export interface TransactionDetailResponse {
  data: {
    transaction: EvmTransaction;
  };
}

// ----------------- Indexer Client -----------------
export interface IndexerClientConfig {
  endpoint: string;
  chainId: string;
  timeout?: number;
  headers?: Record<string, string>;
}

// ----------------- Zk Client -----------------
export interface ZkClientConfig {
  endpoint: string;
  timeout?: number;
  headers?: Record<string, string>;
}

export enum EZkClientType {
  MEZON = 'mezon',
  OAUTH = 'oauth',
}

export interface GetZkProofRequest {
  userId: string;
  ephemeralPublicKey: string;
  jwt: string;
  address: string;
  clientType?: EZkClientType;
}

export interface IZkProof {
  proof: string;
  public_input: string;
}
