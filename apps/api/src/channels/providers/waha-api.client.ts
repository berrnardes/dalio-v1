// Thin HTTP client for the WAHA REST API. Exists as its own injectable so
// tests (contract + storm) can replace network I/O with a recorder, and so
// per-clinic WAHA containers (channel plane — DOCUMENTO-EXECUTIVO §2.2) can
// route by host without adapters knowing about HTTP.
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class WahaApiClient {
  private readonly defaultBaseUrl: string;
  private readonly apiKey: string;

  constructor(config: ConfigService) {
    this.defaultBaseUrl = config.get<string>('WAHA_BASE_URL') ?? 'http://localhost:3001';
    this.apiKey = config.get<string>('WAHA_API_KEY') ?? '';
  }

  /** POSTs to a WAHA endpoint; `host` overrides the base URL for sharded containers. */
  async post<T = unknown>(path: string, body: unknown, host?: string | null): Promise<T> {
    const base = host ?? this.defaultBaseUrl;
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': this.apiKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // The response body is WAHA's error detail — safe to log (no message
      // content flows back on errors), and needed to debug session issues.
      const detail = await res.text().catch(() => '');
      throw new Error(`WAHA ${path} failed: ${res.status} ${detail.slice(0, 500)}`);
    }
    return (await res.json().catch(() => ({}))) as T;
  }
}
