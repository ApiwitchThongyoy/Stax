import type { Route } from "./+types/Login";
import Login from "../component/Login/Login";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "STAX" },
    { name: "description", content: "Welcome to React Router!" },
  ];
}

export default function Home() {
  return <Login />;
}
