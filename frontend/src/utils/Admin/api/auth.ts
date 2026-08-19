// src/api/auth.ts
import { api } from "./api";

export interface LoginPayload {
  username: string;
  password: string; // TOTP
}

export const adminLogin = (data: LoginPayload) =>
  api.post<{ accessToken: string }>("/admin/login", data);

export const adminLogout = () =>
  api.post("/admin/logout");
