import {
    DongClientConfig,
    ClaimRedEnvelopeQRRequest,
    ClaimRedEnvelopeQRResponse,
    ExecuteClaimRedEnvelopeQRRequest,
    CreateRedEnvelopeMobileRequest,
    RedEnvelopeResponse,
    RedEnvelopeStatusResponse,
} from './types';
import { MmnClient } from './mmn-client';

const DEFAULT_ERROR_BODY = 'No error body';

export class DongClient {
    private endpoint: string;
    private timeout: number;
    private headers: Record<string, string>;

    constructor(config: DongClientConfig) {
        this.endpoint = config.endpoint;
        this.timeout = config.timeout || 30000;
        this.headers = {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            ...(config.headers || {}),
        };
    }

    private async makeRequest<T>(
        method: 'GET' | 'POST',
        path: string,
        params?: Record<string, string | number>,
        body?: any
    ): Promise<T> {
        let url = `${this.endpoint}/${path}`;

        if (params && Object.keys(params).length > 0) {
            const searchParams = new URLSearchParams();
            Object.entries(params).forEach(([key, value]) => {
                searchParams.append(key, String(value));
            });
            url += `?${searchParams.toString()}`;
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        try {
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

            if (method === 'POST' && body) {
                requestOptions.body = JSON.stringify(body);
                (requestOptions.headers as Record<string, string>)['Content-Type'] =
                    'application/json';
            }

            const response = await fetch(url, requestOptions);
            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorText = await response.text().catch(() => DEFAULT_ERROR_BODY);
                throw new Error(`HTTP ${response.status}: ${response.statusText} - ${errorText}`);
            }

            const json = await response.json();
            return json.data as T;

        } catch (error) {
            clearTimeout(timeoutId);
            if (error instanceof Error) {
                if (error.name === 'AbortError') {
                    throw new Error(`Request timeout after ${this.timeout}ms`);
                }
                console.error(`[DongClient] Error during request to ${url}:`, error.message);
                throw error;
            }
            console.error(`[DongClient] Unknown error during request to ${url}`);
            throw new Error('Request failed');
        }
    }

    private async get<T>(path: string, params?: Record<string, string | number>): Promise<T> {
        return this.makeRequest<T>('GET', path, params);
    }

    private async post<T>(
        path: string,
        body?: any,
        params?: Record<string, string | number>
    ): Promise<T> {
        return this.makeRequest<T>('POST', path, params, body);
    }

    // --- Red Envelope QR APIs ---

    async claimAmountRedEnvelopeQR(
        params: ClaimRedEnvelopeQRRequest
    ): Promise<ClaimRedEnvelopeQRResponse> {
        const path = `api/v1/red-envelopes/qr/claim-amount`;

        const body = {
            user_id: params.user_id,
            proof_b64: params.proof_b64,
            public_b64: params.public_b64,
            publickey: params.publickey,
        };

        const queryParams = { id: params.id };

        return this.post<ClaimRedEnvelopeQRResponse>(path, body, queryParams);
    }

    async claimRedEnvelopeQR(
        id: string,
        params: ExecuteClaimRedEnvelopeQRRequest
    ): Promise<void> {
        const path = `api/v1/red-envelopes/qr/${id}/claim`;
        await this.post<void>(path, params);
    } 

    async createRedEnvelope(
        params: CreateRedEnvelopeMobileRequest,
        mmnClient?: MmnClient,
        privateKey?: string
      ): Promise<RedEnvelopeResponse> {
        const path = `api/v1/red-envelopes/qr/create`;
    
        let envelope = await this.post<RedEnvelopeResponse>(path, params);

        if (mmnClient && privateKey) {
            const senderAddress = mmnClient.getAddressFromUserId(params.user_id);
            const { nonce } = await mmnClient.getCurrentNonce(params.user_id);

            await mmnClient.sendTransactionByAddress({
                sender: senderAddress,
                recipient: envelope.red_envelope_wallet,
                amount: envelope.total_amount.toString(),
                nonce: nonce,
                privateKey: privateKey,
                zkProof: params.proof_b64,
                zkPub: params.public_b64,
                publicKey: params.publickey,
            });

            // Polling: every 2 seconds in 2 times
            for (let i = 0; i < 2; i++) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                try {
                    const statusRes = await this.getRedEnvelopeStatus(envelope.id);
                    if (statusRes.status === 'PUBLISHED') {
                        envelope.status = statusRes.status;
                        break;
                    }
                } catch (error) {
                    console.error('[DongClient] Error polling red envelope status:', error);
                }
            }
        }

        return envelope;
    }

    async getRedEnvelopeStatus(id: string): Promise<RedEnvelopeStatusResponse> {
        const path = `api/v1/red-envelopes/qr/${id}/status`;
        return this.get<RedEnvelopeStatusResponse>(path);
    }
}
