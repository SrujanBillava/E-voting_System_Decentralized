// src/hooks/useLogin.ts
import API from '../utils/Voter/api/api';
import { useAuth } from '../context/AuthContext';
import { type Voter } from '../types/Voter';

interface LoginCredentials {
  email: string;
  password: string;
}

export const useLogin = () => {
  const { login } = useAuth();

  const loginUser = async (credentials: LoginCredentials): Promise<void> => {
    try {
      const response = await API.post<Voter>('/voter/login', credentials);
      login(response.data);
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Login failed');
    }
  };

  return { loginUser };
};