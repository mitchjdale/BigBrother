import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTheme, type Theme } from "@/lib/theme";

const ORDER: Theme[] = ["system", "light", "dark"];
const ICON = { system: Monitor, light: Sun, dark: Moon } as const;
const LABEL = { system: "System", light: "Light", dark: "Dark" } as const;

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const Icon = ICON[theme];
  const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];

  return (
    <Button
      variant="outline"
      size="icon"
      onClick={() => setTheme(next)}
      title={`Theme: ${LABEL[theme]} (click for ${LABEL[next]})`}
      aria-label={`Switch theme, currently ${LABEL[theme]}`}
    >
      <Icon className="h-4 w-4" />
    </Button>
  );
}
