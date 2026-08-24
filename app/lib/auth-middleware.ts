import jwt from "jsonwebtoken";

export interface AuthPayload {
  userId: string;
  email: string;
  role: string;
}

export interface AuthError {
  status: number;
  message: string;
}

export function verifyAuth(request: Request): AuthPayload | AuthError {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    return { status: 500, message: "Internal server error" };
  }

  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { status: 401, message: "Missing or invalid authorization header" };
  }

  const token = authHeader.slice(7);
  if (!token) {
    return { status: 401, message: "Missing token" };
  }

  try {
    const decoded = jwt.verify(token, jwtSecret) as AuthPayload;
    if (!decoded.userId || !decoded.email || !decoded.role) {
      return { status: 401, message: "Invalid token payload" };
    }
    return decoded;
  } catch {
    return { status: 401, message: "Invalid or expired token" };
  }
}
