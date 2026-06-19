// Q-assist template setup script
// Run this once to populate the template data, then delete this file

const templateData = {
  projects: [{
    id: "qassist1",
    name: "Q-assist",
    deadline: "",
    restDays: [],
    holidays: [],
    themes: [
      {
        id: "naika-geka",
        name: "内科・外科",
        total: 0,
        completed: 0,
        deadline: "",
        expanded: true,
        children: [
          {
            id: "a-shokakan",
            name: "A.消化管",
            total: 0,
            completed: 0,
            deadline: "",
            expanded: true,
            children: [
              { id: "a1", name: "消化管総論", total: 18, completed: 0, deadline: "", children: [], expanded: true },
              { id: "a2", name: "食道疾患", total: 14, completed: 0, deadline: "", children: [], expanded: true },
              { id: "a3", name: "胃十二指腸疾患", total: 19, completed: 0, deadline: "", children: [], expanded: true },
              { id: "a4", name: "腸疾患", total: 37, completed: 0, deadline: "", children: [], expanded: true },
              { id: "a5", name: "肛門疾患", total: 6, completed: 0, deadline: "", children: [], expanded: true },
              { id: "a6", name: "ヘルニア", total: 6, completed: 0, deadline: "", children: [], expanded: true },
              { id: "a7", name: "周術期の管理", total: 4, completed: 0, deadline: "", children: [], expanded: true },
              { id: "a8", name: "消化管 残りの問題", total: 1, completed: 0, deadline: "", children: [], expanded: true }
            ]
          },
          {
            id: "b-kantansui",
            name: "B.肝胆膵",
            total: 0,
            completed: 0,
            deadline: "",
            expanded: true,
            children: [
              { id: "b1", name: "肝臓総論", total: 13, completed: 0, deadline: "", children: [], expanded: true },
              { id: "b2", name: "ウイルス性肝炎", total: 10, completed: 0, deadline: "", children: [], expanded: true },
              { id: "b3", name: "劇症肝炎・肝硬変,門脈圧亢進症", total: 11, completed: 0, deadline: "", children: [], expanded: true },
              { id: "b4", name: "代謝性肝疾患", total: 9, completed: 0, deadline: "", children: [], expanded: true },
              { id: "b5", name: "自己免疫疾患が関与する肝疾患", total: 5, completed: 0, deadline: "", children: [], expanded: true },
              { id: "b6", name: "肝占拠性病変", total: 12, completed: 0, deadline: "", children: [], expanded: true },
              { id: "b7", name: "胆道総論", total: 10, completed: 0, deadline: "", children: [], expanded: true },
              { id: "b8", name: "胆道疾患", total: 12, completed: 0, deadline: "", children: [], expanded: true },
              { id: "b9", name: "膵臓総論", total: 2, completed: 0, deadline: "", children: [], expanded: true },
              { id: "b10", name: "膵臓疾患", total: 13, completed: 0, deadline: "", children: [], expanded: true },
              { id: "b11", name: "肝胆膵 残りの問題", total: 1, completed: 0, deadline: "", children: [], expanded: true }
            ]
          },
          {
            id: "update2024",
            name: "2024アップデート動画",
            total: 1,
            completed: 0,
            deadline: "",
            children: [],
            expanded: true
          },
          {
            id: "c-junkanki",
            name: "C.循環器",
            total: 0,
            completed: 0,
            deadline: "",
            expanded: true,
            children: [
              { id: "c1", name: "心臓総論", total: 23, completed: 0, deadline: "", children: [], expanded: true },
              { id: "c2", name: "心不全", total: 7, completed: 0, deadline: "", children: [], expanded: true },
              { id: "c3", name: "不整脈", total: 14, completed: 0, deadline: "", children: [], expanded: true },
              { id: "c4", name: "虚血性心疾患", total: 11, completed: 0, deadline: "", children: [], expanded: true },
              { id: "c5", name: "弁膜症", total: 11, completed: 0, deadline: "", children: [], expanded: true },
              { id: "c6", name: "心内膜疾患", total: 5, completed: 0, deadline: "", children: [], expanded: true },
              { id: "c7", name: "心筋疾患", total: 10, completed: 0, deadline: "", children: [], expanded: true },
              { id: "c8", name: "心臓疾患", total: 7, completed: 0, deadline: "", children: [], expanded: true },
              { id: "c9", name: "血管総論", total: 2, completed: 0, deadline: "", children: [], expanded: true },
              { id: "c10", name: "動脈疾患", total: 2, completed: 0, deadline: "", children: [], expanded: true },
              { id: "c11", name: "静脈・リンパ管疾患", total: 8, completed: 0, deadline: "", children: [], expanded: true },
              { id: "c12", name: "血圧の異常", total: 4, completed: 0, deadline: "", children: [], expanded: true },
              { id: "c13", name: "循環器 残りの問題", total: 1, completed: 0, deadline: "", children: [], expanded: true }
            ]
          }
        ]
      }
    ],
    createdAt: Date.now()
  }],
  activeProjectId: "qassist1",
  lastBackup: Date.now()
};

// Only load if not already loaded
const existing = localStorage.getItem("progressTracker_v2");
const alreadyLoaded = existing && JSON.parse(existing).activeProjectId === "qassist1";
if (!alreadyLoaded) {
  localStorage.setItem("progressTracker_v2", JSON.stringify(templateData));
  console.log("Q-assist template loaded! Redirecting...");
  location.href = "index.html";
} else {
  console.log("Q-assist template already loaded.");
  location.href = "index.html";
}
