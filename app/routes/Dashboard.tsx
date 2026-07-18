import type { Route } from "./+types/Dashboard";
import Dashboard from "../component/DashboardUser/Dashboard";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "STAX - แดชบอร์ด" },
  ];
}

export default function DashboardPage() {
  return <Dashboard />;
}