import { sections } from "../data/architecture";
import { ChevronRight, Settings2, FileText, Cpu, Gauge, Globe, CarFront, Wind } from "lucide-react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: (string | undefined | null | false)[]) {
  return twMerge(clsx(inputs));
}

interface SidebarProps {
  activeView: "docs" | "phase1" | "phase2" | "phase3" | "phase4" | "phase5" | "phase6" | "phase7" | "phase8" | "phase9";
  activeSection: string;
  onSelectSection: (id: string) => void;
  onSelectView: (view: "docs" | "phase1" | "phase2" | "phase3" | "phase4" | "phase5" | "phase6" | "phase7" | "phase8" | "phase9") => void;
}

export function Sidebar({ activeView, activeSection, onSelectSection, onSelectView }: SidebarProps) {
  return (
    <div className="w-80 h-screen overflow-y-auto bg-stone-950 border-r border-stone-800 flex flex-col hide-scrollbar shrink-0">
      <div className="p-6 pb-4 sticky top-0 bg-stone-950/90 backdrop-blur-sm z-10">
        <h1 className="text-stone-100 font-mono font-bold tracking-tight mb-1 text-lg">Physical Engine DSP</h1>
        <p className="text-stone-500 font-mono text-xs uppercase tracking-widest">Architecture V1.2</p>
      </div>

      <div className="px-4 mb-6 space-y-2">
        <button
          onClick={() => onSelectView("phase9")}
          className={cn(
            "w-full text-left px-4 py-3 rounded-md flex items-center justify-between group transition-all duration-200 border",
            activeView === "phase9"
              ? "bg-fuchsia-500/10 border-fuchsia-500/30 text-fuchsia-400"
              : "bg-stone-900 border-stone-800 text-stone-500 hover:bg-stone-800/80 hover:text-stone-300"
          )}
        >
          <div className="flex items-center gap-3">
            <Cpu size={16} />
            <span className="font-mono text-xs font-bold tracking-wide uppercase">Phase 9: Physical Engine</span>
          </div>
        </button>

        <button
          onClick={() => onSelectView("phase8")}
          className={cn(
            "w-full text-left px-4 py-3 rounded-md flex items-center justify-between group transition-all duration-200 border",
            activeView === "phase8"
              ? "bg-indigo-500/10 border-indigo-500/30 text-indigo-400"
              : "bg-stone-900 border-stone-800 text-stone-500 hover:bg-stone-800/80 hover:text-stone-300"
          )}
        >
          <div className="flex items-center gap-3">
            <Globe size={16} />
            <span className="font-mono text-xs font-bold tracking-wide uppercase">Phase 8: Studio Mix</span>
          </div>
        </button>

        <button
          onClick={() => onSelectView("phase7")}
          className={cn(
            "w-full text-left px-4 py-3 rounded-md flex items-center justify-between group transition-all duration-200 border",
            activeView === "phase7"
              ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
              : "bg-stone-900 border-stone-800 text-stone-500 hover:bg-stone-800/80 hover:text-stone-300"
          )}
        >
          <div className="flex items-center gap-3">
            <Globe size={16} />
            <span className="font-mono text-xs font-bold tracking-wide uppercase">Phase 7: Full System</span>
          </div>
        </button>

        <button
          onClick={() => onSelectView("phase6")}
          className={cn(
            "w-full text-left px-4 py-3 rounded-md flex items-center justify-between group transition-all duration-200 border",
            activeView === "phase6"
              ? "bg-cyan-500/10 border-cyan-500/30 text-cyan-400"
              : "bg-stone-900 border-stone-800 text-stone-500 hover:bg-stone-800/80 hover:text-stone-300"
          )}
        >
          <div className="flex items-center gap-3">
            <Wind size={16} />
            <span className="font-mono text-xs font-bold tracking-wide uppercase">Phase 6: Turbo</span>
          </div>
        </button>

        <button
          onClick={() => onSelectView("phase5")}
          className={cn(
            "w-full text-left px-4 py-3 rounded-md flex items-center justify-between group transition-all duration-200 border",
            activeView === "phase5"
              ? "bg-indigo-500/10 border-indigo-500/30 text-indigo-400"
              : "bg-stone-900 border-stone-800 text-stone-500 hover:bg-stone-800/80 hover:text-stone-300"
          )}
        >
          <div className="flex items-center gap-3">
            <CarFront size={16} />
            <span className="font-mono text-xs font-bold tracking-wide uppercase">Phase 5: Drivetrain</span>
          </div>
        </button>

        <button
          onClick={() => onSelectView("phase4")}
          className={cn(
            "w-full text-left px-4 py-3 rounded-md flex items-center justify-between group transition-all duration-200 border",
            activeView === "phase4"
              ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
              : "bg-stone-900 border-stone-800 text-stone-500 hover:bg-stone-800/80 hover:text-stone-300"
          )}
        >
          <div className="flex items-center gap-3">
            <Globe size={16} />
            <span className="font-mono text-xs font-bold tracking-wide uppercase">Phase 4: Production</span>
          </div>
        </button>

        <button
          onClick={() => onSelectView("phase3")}
          className={cn(
            "w-full text-left px-4 py-3 rounded-md flex items-center justify-between group transition-all duration-200 border",
            activeView === "phase3"
              ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
              : "bg-stone-900 border-stone-800 text-stone-500 hover:bg-stone-800/80 hover:text-stone-300"
          )}
        >
          <div className="flex items-center gap-3">
            <Gauge size={16} />
            <span className="font-mono text-xs font-bold tracking-wide uppercase">Phase 3: Transients</span>
          </div>
        </button>

        <button
          onClick={() => onSelectView("phase2")}
          className={cn(
            "w-full text-left px-4 py-3 rounded-md flex items-center justify-between group transition-all duration-200 border",
            activeView === "phase2"
              ? "bg-stone-800 text-stone-200 border-stone-700"
              : "bg-stone-900 border-stone-800 text-stone-500 hover:bg-stone-800/80 hover:text-stone-300"
          )}
        >
          <div className="flex items-center gap-3">
            <Settings2 size={16} />
            <span className="font-mono text-xs font-bold tracking-wide uppercase">Phase 2: Networks</span>
          </div>
        </button>

        <button
          onClick={() => onSelectView("phase1")}
          className={cn(
            "w-full text-left px-4 py-3 rounded-md flex items-center justify-between group transition-all duration-200 border",
            activeView === "phase1"
              ? "bg-stone-800 text-stone-200 border-stone-700"
              : "bg-stone-900 border-stone-800 text-stone-500 hover:bg-stone-800/80 hover:text-stone-300"
          )}
        >
          <div className="flex items-center gap-3">
            <Cpu size={16} />
            <span className="font-mono text-xs font-bold tracking-wide uppercase">Phase 1: MVP</span>
          </div>
        </button>
      </div>

      <div className="px-6 mb-2 mt-4 border-t border-stone-800/50 pt-4">
         <div className="flex items-center gap-2 mb-2 text-stone-500">
            <FileText size={14} />
            <span className="font-mono text-[10px] uppercase tracking-widest font-bold">Documentation</span>
         </div>
      </div>

      <nav className="flex-1 px-4 py-2 space-y-1">
        {sections.map((section) => {
          const isActive = activeView === "docs" && activeSection === section.id;
          return (
            <button
              key={section.id}
              onClick={() => {
                onSelectView("docs");
                onSelectSection(section.id);
              }}
              className={cn(
                "w-full text-left px-3 py-2 rounded-md flex items-center justify-between group transition-all duration-200",
                isActive 
                  ? "bg-stone-800/80 text-stone-100" 
                  : "text-stone-400 hover:bg-stone-900/60 hover:text-stone-200"
              )}
            >
              <span className="font-mono text-xs whitespace-nowrap overflow-hidden text-ellipsis mr-2">
                {section.title}
              </span>
              <ChevronRight 
                size={14} 
                className={cn(
                  "opacity-0 transition-opacity duration-200 shrink-0", 
                  isActive ? "opacity-100 text-stone-400" : "group-hover:opacity-100 text-stone-600"
                )} 
              />
            </button>
          );
        })}
      </nav>
      <div className="p-4 mt-auto border-t border-stone-800/50 sticky bottom-0 bg-stone-950/90 backdrop-blur">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
          <span className="text-stone-500 font-mono text-[10px] uppercase">STATUS: SYSTEM READY</span>
        </div>
      </div>
    </div>
  );
}
