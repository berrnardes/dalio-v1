// REST client for the Dalio api — SPEC §7 surface. Cookie-based Better-auth
// session, so every request (and the SSE stream) must carry credentials.
import axios from 'axios';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

export const api = axios.create({
  baseURL: `${API_URL}/api/v1`,
  withCredentials: true,
});
