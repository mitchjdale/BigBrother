import { NavLink, useLocation } from "react-router-dom";
import DashboardPage from "@/pages/DashboardPage";
import UsagePage from "@/pages/UsagePage";
import { ThemeToggle } from "@/components/ThemeToggle";
import { BarChart3, ListChecks } from "lucide-react";
import insigniaLogo from "@/assets/insignia-logo.png";

function navClass({ isActive }: { isActive: boolean }): string {
  return `inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
    isActive
      ? "border border-transparent bg-primary text-primary-foreground"
      : "border border-input bg-background text-[#57606a] hover:bg-accent dark:text-[#8b949e]"
  }`;
}

export default function App() {
  const { pathname } = useLocation();
  const isUsage = pathname === "/usage";

  return (
    <div className="flex h-screen flex-col">
      <header className="flex w-full items-center justify-between gap-4 border-b bg-[#f6f8fa] px-6 py-3 text-[#24292f] dark:bg-[#161b22] dark:text-[#e6edf3]">
        <div className="flex items-center gap-2">
          <img src={insigniaLogo} alt="Insignia Financial" className="h-7 w-7" />
          <div>
            <h1 className="text-lg font-bold leading-none">BigBrother</h1>
            <p className="mt-1 text-xs text-[#57606a] dark:text-[#8b949e]">AI implementation planning for your tickets</p>
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
      </header>

      <div className="mx-auto flex min-h-0 w-full max-w-[1400px] flex-1 flex-col">
        <div className={isUsage ? "hidden" : "flex min-h-0 flex-1 flex-col"}>
          <DashboardPage />
        </div>
        <div className={isUsage ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
          <UsagePage />
        </div>
      </div>
    </div>
  );
}
