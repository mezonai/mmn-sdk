import {
  IndexerClientConfig,
  ListTransactionResponse,
  Meta,
  Transaction,
  TransactionDetailResponse,
  WalletDetail,
  WalletDetailResponse,
} from './types';
import {
  TransactionInfiniteResponse,
  TransactionItem,
} from './gen/transaction_infinite_pb';

const API_FILTER_PARAMS = {
  ALL: 0,
  SENT: 2,
  RECEIVED: 1,
};

/**
 * Convert protobuf TransactionItem to Transaction type
 */
function mapTransactionItemToTransaction(item: TransactionItem): Transaction {
  const transaction: Transaction = {
    chain_id: item.chainId,
    hash: item.hash,
    nonce: Number(item.nonce),
    block_hash: item.blockHash,
    block_number: Number(item.blockNumber),
    block_timestamp: 0,
    transaction_index: 0,
    from_address: item.fromAddress,
    to_address: item.toAddress,
    value: item.value,
    gas: 0,
    gas_price: '0',
    data: '',
    function_selector: '',
    max_fee_per_gas: '0',
    max_priority_fee_per_gas: '0',
    transaction_type: item.transactionType,
    r: '',
    s: '',
    v: '',
    transaction_timestamp: Number(item.transactionTimestamp),
    text_data: item.textData,
    extra_info: item.extraInfo,
  };

  if (item.status !== undefined) {
    transaction.status = Number(item.status);
  }

  return transaction;
}

/**
 * Convert protobuf TransactionInfiniteResponse to ListTransactionResponse
 */
function mapProtoToListTransactionResponse(
  protoResponse: TransactionInfiniteResponse
): ListTransactionResponse {
  const meta: Meta = {
    chain_id: Number(protoResponse.meta?.chainId) || 0,
    page: protoResponse.meta?.page || 0,
    limit: protoResponse.meta?.limit || 0,
    has_more: protoResponse.meta?.hasMore || false,
    next_hash: protoResponse.meta?.nextHash || '',
  };

  // Only set next_timestamp if it exists
  if (protoResponse.meta?.nextTimestamp) {
    meta.next_timestamp = protoResponse.meta.nextTimestamp.toString();
  }

  const data: Transaction[] = protoResponse.data.map(mapTransactionItemToTransaction);

  return { meta, data };
}

export class IndexerClient {
  private endpoint: string;
  private chainId: string;
  private timeout: number;
  private headers: Record<string, string>;

  constructor(config: IndexerClientConfig) {
    this.endpoint = config.endpoint;
    this.chainId = config.chainId;
    this.timeout = config.timeout || 30000;

    // Minimal headers to avoid CORS preflight issues
    this.headers = {
      Accept: 'application/json',
      ...(config.headers || {}),
    };
  }

  /**
   * Make HTTP request with automatic CORS handling
   * Works out-of-the-box without CORS configuration
   * @param method - HTTP method (GET or POST)
   * @param path - API endpoint path
   * @param params - URL query parameters
   * @param body - Request body for POST requests
   * @returns Promise resolving to response data
   */
  private async makeRequest<T>(
    method: 'GET' | 'POST',
    path: string,
    params?: Record<string, string | number>,
    body?: any
  ): Promise<T> {
    // Build full URL
    let url = `${this.endpoint}/${path}`;

    // Add query parameters
    if (params && Object.keys(params).length > 0) {
      const searchParams = new URLSearchParams();
      Object.entries(params).forEach(([key, value]) => {
        searchParams.append(key, String(value));
      });
      url += `?${searchParams.toString()}`;
    }

    // Create AbortController for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      // Simple fetch with automatic CORS handling
      const requestOptions: RequestInit = {
        method,
        mode: 'cors',
        credentials: 'omit',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...this.headers,
        },
      };

      // Add body and Content-Type for POST requests
      if (method === 'POST' && body) {
        requestOptions.body = JSON.stringify(body);
        (requestOptions.headers as Record<string, string>)['Content-Type'] =
          'application/json';
      }

      const response = await fetch(url, requestOptions);
      clearTimeout(timeoutId);

      // Handle response errors
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Parse JSON response
      const data = await response.json();
      return data as T;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new Error(`Request timeout after ${this.timeout}ms`);
        }
        throw error;
      }

      throw new Error('Request failed');
    }
  }

  async getTransactionByHash(hash: string): Promise<Transaction> {
    const path = `${this.chainId}/tx/${hash}/detail`;
    const res = await this.makeRequest<TransactionDetailResponse>('GET', path);
    return res.data.transaction;
  }
  async getTransactionsByWalletBeforeTimestamp(
    wallet: string,
    filter: number,
    limit?: number,
    timestamp_lt?: string,
    last_hash?: string
  ): Promise<ListTransactionResponse> {
    if (!wallet) {
      throw new Error("wallet address cannot be empty");
    }

    let finalLimit = limit && limit > 0 ? limit : 20;
    if (finalLimit > 1000) finalLimit = 1000;

    const params: Record<string, string | number> = {
      limit: finalLimit,
      ...(timestamp_lt && { timestamp_lt }),
      ...(last_hash && { last_hash }),
    };

    switch (filter) {
      case API_FILTER_PARAMS.ALL:
        params["wallet_address"] = wallet;
        break;
      case API_FILTER_PARAMS.SENT:
        params["filter_from_address"] = wallet;
        break;
      case API_FILTER_PARAMS.RECEIVED:
        params["filter_to_address"] = wallet;
        break;
      default:
        break;
    }

    // Build URL with query params
    const path = `${this.chainId}/transactions/infinite`;
    let url = `${this.endpoint}/${path}`;
    if (Object.keys(params).length > 0) {
      const searchParams = new URLSearchParams();
      Object.entries(params).forEach(([key, value]) => {
        searchParams.append(key, String(value));
      });
      url += `?${searchParams.toString()}`;
    }

    // Create AbortController for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        signal: controller.signal,
        headers: {
          Accept: 'application/x-protobuf',
          ...this.headers,
        },
      });
      clearTimeout(timeoutId);

      // Handle HTTP errors - server returns JSON for errors
      if (!response.ok) {
        try {
          const errorData = await response.json();
          throw new Error(
            errorData.message ||
              errorData.error ||
              `HTTP ${response.status}: ${response.statusText}`
          );
        } catch (jsonError) {
          if (jsonError instanceof Error && jsonError.message.includes('HTTP')) {
            throw jsonError;
          }
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
      }

      // Parse binary protobuf response
      const arrayBuffer = await response.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);
      const protoResponse = TransactionInfiniteResponse.fromBinary(uint8Array);
      return mapProtoToListTransactionResponse(protoResponse);
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new Error(`Request timeout after ${this.timeout}ms`);
        }
        throw error;
      }
      throw new Error('Request failed');
    }
  }

  async getTransactionByWallet(
    wallet: string,
    page = 1,
    limit = 50,
    filter: number,
    sortBy = 'transaction_timestamp',
    sortOrder: 'asc' | 'desc' = 'desc'
  ): Promise<ListTransactionResponse> {
    if (!wallet) {
      throw new Error('wallet address cannot be empty');
    }

    if (page < 1) page = 1;
    if (limit <= 0) limit = 50;
    if (limit > 1000) limit = 1000;

    const params: Record<string, string | number> = {
      page: page - 1,
      limit,
      sort_by: sortBy,
      sort_order: sortOrder,
    };

    switch (filter) {
      case API_FILTER_PARAMS.ALL:
        params['wallet_address'] = wallet;
        break;
      case API_FILTER_PARAMS.SENT:
        params['filter_from_address'] = wallet;
        break;
      case API_FILTER_PARAMS.RECEIVED:
        params['filter_to_address'] = wallet;
        break;
      default:
        break;
    }

    const path = `${this.chainId}/transactions`;
    return this.makeRequest<ListTransactionResponse>('GET', path, params);
  }

  async getWalletDetail(wallet: string): Promise<WalletDetail> {
    if (!wallet) {
      throw new Error('wallet address cannot be empty');
    }

    const path = `${this.chainId}/wallets/${wallet}/detail`;
    const res = await this.makeRequest<WalletDetailResponse>('GET', path);
    return res.data;
  }
}
