import { NavLink, useLocation } from "react-router-dom";
import DashboardPage from "@/pages/DashboardPage";
import UsagePage from "@/pages/UsagePage";
import { ThemeToggle } from "@/components/ThemeToggle";
import { BarChart3, Eye, ListChecks } from "lucide-react";

function navClass({ isActive }: { isActive: boolean }): string {
  return `inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
    isActive ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"
  }`;
}

export default function App() {
  const { pathname } = useLocation();
  const isUsage = pathname === "/usage";

  return (
    <div className="mx-auto flex h-screen max-w-[1400px] flex-col">
      <div className="flex items-center justify-between gap-4 border-b px-6 py-3">
        <div className="flex items-center gap-2">
          <Eye className="h-5 w-5" />
          <div>
            <h1 className="text-lg font-bold leading-none">BigBrother</h1>
            <p className="text-xs text-muted-foreground">AI implementation planning for your tickets</p>
          </div>
        </div>
        <nav className="flex items-center gap-1">
          <NavLink to="/" end className={navClass}>
            <ListChecks className="h-4 w-4" /> Dashboard
          </NavLink>
          <NavLink to="/usage" className={navClass}>
            <BarChart3 className="h-4 w-4" /> Usage
          </NavLink>
          <div className="ml-1">
            <ThemeToggle />
          </div>
        </nav>
      </div>

      <div className={isUsage ? "hidden" : "flex min-h-0 flex-1 flex-col"}>
        <DashboardPage />
      </div>
      <div className={isUsage ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        <UsagePage />
      </div>
    </div>
  );
}
