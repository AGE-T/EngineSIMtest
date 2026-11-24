/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { ContentArea } from "./components/ContentArea";
import { Phase1Demo } from "./components/Phase1Demo";
import { Phase2Demo } from "./components/Phase2Demo";
import { Phase3Demo } from "./components/Phase3Demo";
import { Phase4Demo } from "./components/Phase4Demo";
import { Phase5Demo } from "./components/Phase5Demo";
import { Phase6Demo } from "./components/Phase6Demo";
import { Phase7Demo } from "./components/Phase7Demo";
import { Phase8Demo } from "./components/Phase8Demo";
import Phase9Demo from "./components/Phase9Demo";
import { sections } from "./data/architecture";

export default function App() {
  const [activeView, setActiveView] = useState<"docs" | "phase1" | "phase2" | "phase3" | "phase4" | "phase5" | "phase6" | "phase7" | "phase8" | "phase9">("phase9");
  const [activeSection, setActiveSection] = useState(sections[0].id);

  const currentContent = sections.find((s) => s.id === activeSection)?.content || "";

  return (
    <div className="flex w-full h-screen bg-stone-900 text-stone-100 font-sans selection:bg-stone-700 selection:text-white">
      <Sidebar 
        activeView={activeView}
        activeSection={activeSection} 
        onSelectSection={setActiveSection}
        onSelectView={setActiveView}
      />
      {activeView === "docs" ? (
         <ContentArea content={currentContent} />
      ) : activeView === "phase9" ? (
         <Phase9Demo />
      ) : activeView === "phase8" ? (
         <Phase8Demo />
      ) : activeView === "phase7" ? (
         <Phase7Demo />
      ) : activeView === "phase6" ? (
         <Phase6Demo />
      ) : activeView === "phase5" ? (
         <Phase5Demo />
      ) : activeView === "phase4" ? (
         <Phase4Demo />
      ) : activeView === "phase3" ? (
         <Phase3Demo />
      ) : activeView === "phase2" ? (
         <Phase2Demo />
      ) : (
         <Phase1Demo />
      )}
    </div>
  );
}
