import axios, { AxiosError } from "axios";

const API_BASE_URL = import.meta.env.VITE_API_URL;

export const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    "Content-Type": "application/json",
  },
  withCredentials: true,
});

// Attach access token
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("accessToken");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const original = error.config as any;

    const isAuthRoute =
      original.url?.includes("/admin/login") ||
      original.url?.includes("/admin/refresh") ||
      original.url?.includes("/admin/logout");

    if (
      error.response?.status === 401 &&
      !original._retry &&
      !isAuthRoute
    ) {
      original._retry = true;

      try {
        const res = await api.get<{ accessToken: string }>(
          "/admin/refresh"
        );

        localStorage.setItem("accessToken", res.data.accessToken);
        return api(original);
      } catch {
        localStorage.removeItem("accessToken");
        window.location.href = "/login";
      }
    }

    return Promise.reject(error);
  }
);
