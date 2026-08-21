import type { Route } from "./+types/users";
import { db } from "~/lib/drizzle-db";
import { users } from "~/db/schema";
import { verifyAuth } from "~/lib/auth-middleware";

function isAuthError(result: unknown): result is { status: number; message: string } {
  return (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    "message" in result
  );
}

export async function loader({ request }: Route.LoaderArgs) {
  const auth = verifyAuth(request);
  if (isAuthError(auth)) {
    return Response.json(
      { success: false, message: auth.message },
      { status: auth.status }
    );
  }

  if (auth.role !== "ADMIN") {
    return Response.json(
      { success: false, message: "Forbidden" },
      { status: 403 }
    );
  }

  try {
    const rows = db
      .select({
        id: users.id,
        email: users.email,
        role: users.role,
        status: users.status,
      })
      .from(users)
      .all();

    return Response.json({ success: true, data: rows }, { status: 200 });
  } catch (error) {
    console.error("AdminUsers GET: failed to query", error);
    return Response.json(
      { success: false, message: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function action(_: Route.ActionArgs) {
  return Response.json(
    { success: false, message: "Method not allowed" },
    { status: 405 }
  );
}
