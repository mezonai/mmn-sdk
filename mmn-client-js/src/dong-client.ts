import {
    DongClientConfig,
    ClaimRedEnvelopeQRRequest,
    ClaimRedEnvelopeQRResponse,
    ExecuteClaimRedEnvelopeQRRequest,
} from './types';

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
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const json = await response.json();
            return json.data as T;

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

        return this.makeRequest<ClaimRedEnvelopeQRResponse>(
            'POST',
            path,
            queryParams,
            body
        );
    }

    async claimRedEnvelopeQR(
        id: string,
        params: ExecuteClaimRedEnvelopeQRRequest
    ): Promise<void> {
        const path = `api/v1/red-envelopes/qr/${id}/claim`;
        await this.makeRequest<void>('POST', path, undefined, params);
    }
}
