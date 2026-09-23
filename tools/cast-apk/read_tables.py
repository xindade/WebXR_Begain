import subprocess, json, re
PY="C:/Users/x/.workbuddy/binaries/python/versions/3.13.12/python.exe"
edsdk="C:/Users/x/AppData/Local/Programs/WorkBuddy/resources/app.asar.unpacked/resources/plugins/workbuddy-builtin/skills/tencent-local-office-edit/edsdk.py"
fid="F:/desk/LinSHi/VR+平台对接协议V2.9.doc"
for tid in ["5pcgjc19","rowcx77f","s8mu8be1","3o5381r2","jn10ha1j"]:
    out=subprocess.run([PY, edsdk, "call", "doc_get_table_info", "--json", json.dumps({"file_id":fid,"table_id":tid})], capture_output=True, text=True).stdout
    m=re.search(r'\{.*\}', out, re.S)
    if not m:
        print("==",tid,"NOJSON", out[:200]); continue
    d=json.loads(m.group(0))
    print("\n===== TABLE", tid, "rows=", d.get("row_count"), "cols=", d.get("col_count"), "=====")
    txt=json.dumps(d, ensure_ascii=False)
    texts=re.findall(r'"text"\s*:\s*"((?:[^"\\]|\\.)*)"', txt)
    # also capture 'value' maybe
    print(" || ".join(texts[:300]))
