import {
  createContext,
  useContext,
  useState,
  useEffect,
  type ReactNode,
} from "react";
import { type Voter } from "../types/Voter";

interface AuthContextType {
  voter: Voter | null;
  login: (userData: Voter) => void;
  logout: () => void;
  isAuthenticated: boolean;
  loading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [voter, setUser] = useState<Voter | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const storedUser = sessionStorage.getItem("voterObject");
    if (storedUser) {
      setUser(JSON.parse(storedUser));
    }
    setLoading(false); // Done loading
  }, []);

  const login = (userData: Voter) => {
    setUser(userData);
    sessionStorage.setItem("voterObject", JSON.stringify(userData));
  };

  const logout = () => {
    setUser(null);
    sessionStorage.removeItem("voterObject");
  };

  return (
    <AuthContext.Provider
      value={{
        voter,
        login,
        logout,
        isAuthenticated: !!voter,
        loading,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within an AuthProvider");
  return context;
};