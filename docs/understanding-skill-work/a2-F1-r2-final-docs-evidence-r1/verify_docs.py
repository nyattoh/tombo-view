from pathlib import Path
import json,hashlib,datetime,subprocess,difflib
root=Path.cwd();out=root/"results/understanding-acceptance2/docs/F1-r2"
before=json.loads((out/"before.json").read_text(encoding="utf-8"));commands=[]
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
def run(name,args):
 start=datetime.datetime.now().astimezone().isoformat();r=subprocess.run(args,cwd=root,capture_output=True,text=True,encoding="utf-8");end=datetime.datetime.now().astimezone().isoformat()
 log=out/(name+".log");log.write_text(r.stdout+r.stderr,encoding="utf-8")
 row={"command":subprocess.list2cmdline(args),"args":args,"start":start,"end":end,"exit":r.returncode,"log":name+".log","log_sha256":sha(log)};commands.append(row);print(json.dumps(row,ensure_ascii=False));print(r.stdout+r.stderr)
run("quick-validate",["python","C:/Users/ryoko/.codex/skills/.system/skill-creator/scripts/quick_validate.py","skills/tombo-view"])
run("diff-check",["git","diff","--check","--","README.md","skills/tombo-view/references/host-session.md"])
rows=[];old={};new={};patch=[]
for i in before["files"]:
 p=root/i["path"];row={"path":i["path"],"before_sha256":i["sha256"],"sha256":sha(p),"before_mtime_ns":i["mtime_ns"],"mtime_ns":p.stat().st_mtime_ns,"unchanged_bytes":sha(p)==i["sha256"],"unchanged_mtime":p.stat().st_mtime_ns==i["mtime_ns"]};rows.append(row)
 if i["text"] is not None:
  old[i["path"]]=i["text"];new[i["path"]]=p.read_bytes().decode("utf-8")
  patch.append("".join(difflib.unified_diff(i["text"].replace("\r\n","\n").splitlines(True),new[i["path"]].replace("\r\n","\n").splitlines(True),fromfile=i["path"]+" (pre-F1-docs)",tofile=i["path"]+" (F1-docs)")))
def sec(t,a,b=None):return t[t.index(a):t.index(b,t.index(a)) if b else None]
checks={}
for key,a,b in [("readme_fixed_japanese","## 検証で分かったこと","## アーキテクチャ"),("readme_fixed_english","### What has been verified","### Use TOMBO in a conversation"),("readme_hidden_crossrag_japanese","## Hidden-Side Observation（任意）","## English"),("readme_hidden_crossrag_english","### Hidden-Side Observation (optional)","An adapter supplies")]:checks[key]=sec(old["README.md"],a,b)==sec(new["README.md"],a,b)
host="skills/tombo-view/references/host-session.md";a=old[host].index("現在のstopReasonが `invalid_model_output` で、最後のmodelRepairDiagnostics");b=old[host].index("reflectが検証で止まった場合は",a);na=new[host].index("managed helperは `captureProposalRejection: true`");nb=new[host].index("reflectが検証で止まった場合は",na)
checks["host_bytes_outside_recovery_explanation"]=old[host][:a]==new[host][:na] and old[host][b:]==new[host][nb:]
checks["F3_existing_resolution_paragraph_unchanged"]=sec(old[host],"既存probeで扱える観測をupdateする。","本人の重要な優先順位で選択が逆転するなら")==sec(new[host],"既存probeで扱える観測をupdateする。","本人の重要な優先順位で選択が逆転するなら")
active={"src/core.ts","src/types.ts","skills/tombo-view/scripts/session.mjs","test/cli-model-repair.test.mjs","test/session-followup.test.mjs"}
checks["protected_non_owned_files_bytes_mtime_unchanged"]=all(r["unchanged_bytes"] and r["unchanged_mtime"] for r in rows if r["path"] not in old and r["path"] not in active)
checks["owned_two_files_changed"]=all(not r["unchanged_bytes"] for r in rows if r["path"] in old)
history=[{"path":str(p.relative_to(root)).replace("\\","/"),"sha256":sha(p)} for p in sorted((root/"docs/ask-policy-work").rglob("*")) if p.is_file()]
checks["historical_409_path_hashes_preserved"]=history==before["historical"] and len(history)==409
asks=subprocess.check_output(["git","ls-files","--others","--exclude-standard","--","docs/ask-policy-work"],text=True).splitlines();checks["ask_192_untracked_preserved"]=asks==before["ask_untracked"] and len(asks)==192
api=root/before["API"]["path"];api_text=api.read_text(encoding="utf-8-sig")
checks["API_specification_unchanged_append_only"]=api_text.startswith(before["API"]["text"].rstrip())
api_diff="".join(difflib.unified_diff(before["API"]["text"].splitlines(True),api_text.splitlines(True),fromfile="API-GREEN milestone",tofile="current API"));(out/"API-readback-diff.patch").write_text(api_diff,encoding="utf-8")
(out/"API-final-readback.md").write_text(api_text,encoding="utf-8")
inputs=["docs/understanding-skill-work/a2-F1-r2-docs-contract-GREEN-brief-r1.md","docs/understanding-skill-work/a2-F1-r2-API-GREEN-actual-readback-r1.json","docs/understanding-skill-work/a2-F1-design-conditions-accepted-r1.md","docs/understanding-skill-work/a2-F1-lifecycle-design-r2.md","docs/understanding-skill-work/a2-F1-r2-design-conditions-accepted-r1.md","docs/understanding-skill-work/a2-F1-r2-independent-design-review-r1.md","docs/understanding-skill-work/a2-parent-post-H-audit-integration-r1.json","docs/understanding-skill-work/a2-parent-F1-design-trust-integration-r1.json","docs/understanding-skill-work/parent-final-audit.json","docs/understanding-skill-work/a2-behavioural-evaluation-H-r1.md","results/understanding-acceptance2/docs/post-H/hand_over_summary.md"]
record={"docs_frozen_at":datetime.datetime.now().astimezone().isoformat(),"binding":before["binding"],"branch":before["branch"],"head":before["head"],"commands":commands,"checks":checks,"source_snapshot_not_freeze":rows,"owned_final":[r for r in rows if r["path"] in old],"other14_changes_during_docs":[r["path"] for r in rows if r["path"] not in old and not (r["unchanged_bytes"] and r["unchanged_mtime"])],"milestone_to_initial_snapshot_changes":[r["path"] for r in before["files"] if not r["matches_PM_milestone"]],"API":{"path":before["API"]["path"],"milestone_sha256":before["API"]["sha256"],"readback_sha256":sha(api),"mtime_ns":api.stat().st_mtime_ns,"change":"Only final measured test/freeze paragraph appended. API shape/behaviour unchanged; final figures not adopted as independently verified."},"input_hashes":[{"path":p,"sha256":sha(root/p)} for p in inputs],"runtime_milestone_attribution":{"pass":29,"fail":0,"skip":0,"exit":0,"log_sha256":before["GREEN_log"]["sha256"],"command":"node --test --test-name-pattern='F1' test/cli-model-repair.test.mjs test/session-followup.test.mjs","started_at":"2026-10-21T05:43:35.8428402+09:00","completed_at":"2026-10-21T05:43:49.2380970+09:00","executed_by_docs_writer":False},"runtime_final_packaging_readback":"See final-evidence-read-attempt-1.json; no combined freeze or final test adoption by docs owner.","composite_source_docs_freeze":False,"npm_executed":False,"helper_API_executed":False,"new_worker":False,"costs_tokens":"unknown","scope":"Only README and host-session frozen. Runtime active/final packaging belongs to runtime and PM; no A2/semantic/general-efficacy PASS."}
(out/"verification-summary.json").write_text(json.dumps(record,ensure_ascii=False,indent=2),encoding="utf-8");(out/"source-docs-readback.json").write_text(json.dumps({k:record[k] for k in ["docs_frozen_at","binding","branch","head","owned_final","source_snapshot_not_freeze","API","composite_source_docs_freeze"]},ensure_ascii=False,indent=2),encoding="utf-8");(out/"F1-r2.patch").write_text("".join(patch),encoding="utf-8")
print(json.dumps({"docs_frozen_at":record["docs_frozen_at"],"checks":checks,"other14_changes_during_docs":record["other14_changes_during_docs"],"owned_final":record["owned_final"],"API":record["API"]},ensure_ascii=False,indent=2))
assert all(c["exit"]==0 for c in commands)
assert all(checks.values())
