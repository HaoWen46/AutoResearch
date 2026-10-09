"""Create or update Hangzhou FC 3.0 HTTP function. No secrets printed."""
from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

from alibabacloud_fc20230330.client import Client
from alibabacloud_fc20230330 import models as fc
from alibabacloud_tea_openapi.models import Config
from alibabacloud_tea_util.models import RuntimeOptions

from aliyun_rpc import load_env, rpc
from pack_fc import OUT, main as pack

REGION = "cn-hangzhou"
DEFAULT_NAME = "qiyan"
STATE = Path(__file__).resolve().parent / ".deploy.env"


def account_id(ak: str, sk: str) -> str:
    r = rpc("GetCallerIdentity", {}, version="2015-04-01",
            endpoint="https://sts.aliyuncs.com", ak=ak, sk=sk)
    if r.get("AccountId"):
        return str(r["AccountId"])
    raise SystemExit(f"STS {r.get('Code')} {str(r.get('Message', ''))[:200]}")


def write_state(rows: dict[str, str]) -> None:
    old = {}
    if STATE.exists():
        for line in STATE.read_text(encoding="utf-8").splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                old[k] = v
    old.update(rows)
    STATE.write_text("".join(f"{k}={v}\n" for k, v in old.items()), encoding="utf-8")


def llm_key() -> str:
    app_env = load_env(Path(__file__).resolve().parents[2] / ".env")
    root_env = load_env()
    return (app_env.get("LLM_API_KEY") or root_env.get("DEEPSEEK_API_KEY")
            or root_env.get("LLM_API_KEY") or "")


def client(ak: str, sk: str, aid: str) -> Client:
    return Client(Config(
        access_key_id=ak,
        access_key_secret=sk,
        endpoint=f"{aid}.{REGION}.fc.aliyuncs.com",
        region_id=REGION,
    ))


def main() -> None:
    name = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_NAME
    env = load_env()
    ak, sk = env["AccessKey_ID"], env["AccessKey_Secret"]
    aid = account_id(ak, sk)
    print("ACCOUNT", aid[-4:])
    print("FUNCTION", name)
    pack()
    zip_bytes = OUT.read_bytes()
    print("ZIP_MB", round(len(zip_bytes) / 1024 / 1024, 2))
    cli = client(ak, sk, aid)
    runtime = RuntimeOptions(read_timeout=120000, connect_timeout=30000)
    code = fc.InputCodeLocation(zip_file=base64.b64encode(zip_bytes).decode())
    db_name = "/tmp/qiyan-test.db" if name != DEFAULT_NAME else "/tmp/qiyan.db"
    env_vars = {
        "QIYAN_DB": db_name,
        "LLM_BASE_URL": "https://api.deepseek.com/v1",
        "LLM_MODEL": "deepseek-flash",
        "QIYAN_ENV": "test" if name != DEFAULT_NAME else "prod",
    }
    key = llm_key()
    if key:
        env_vars["LLM_API_KEY"] = key
        env_vars["DEEPSEEK_API_KEY"] = key
    body = fc.CreateFunctionInput(
        function_name=name,
        runtime="custom.debian12",
        handler="index.handler",
        timeout=300,
        memory_size=2048,
        cpu=1,
        disk_size=512,
        instance_concurrency=200,  # 单实例最多 200：多开实例时各有一份库，登录在实例之间来回失效（docs/DEPLOY.md）
        internet_access=True,
        environment_variables=env_vars,
        code=code,
        description="qiyan research mentor" if name == DEFAULT_NAME else "qiyan test (not the public homepage)",
    )
    try:
        created = cli.create_function(fc.CreateFunctionRequest(body=body))
        print("CREATED", created.body.function_name if created.body else "ok")
    except Exception as e:
        msg = str(e)
        print("CREATE", type(e).__name__, msg[:400])
        if "FunctionAlreadyExists" in msg or "already exists" in msg.lower() or "AlreadyExists" in msg:
            upd = fc.UpdateFunctionInput(
                runtime="custom.debian12",
                handler="index.handler",
                timeout=300,
                memory_size=2048,
                cpu=1,
                disk_size=512,
                instance_concurrency=200,  # 单实例最多 200：多开实例时各有一份库，登录在实例之间来回失效（docs/DEPLOY.md）
                internet_access=True,
                environment_variables=env_vars,
                code=code,
            )
            cli.update_function(name, fc.UpdateFunctionRequest(body=upd))
            print("UPDATED")
        else:
            raise
    trig_cfg = json.dumps({
        "authType": "anonymous",
        "methods": ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH"],
        "disableURLInternet": False,
    })
    try:
        cli.create_trigger(name, fc.CreateTriggerRequest(body=fc.CreateTriggerInput(
            trigger_name="http",
            trigger_type="http",
            trigger_config=trig_cfg,
        )))
        print("TRIGGER created")
    except Exception as e:
        print("TRIGGER", type(e).__name__, str(e)[:240])
    url = None
    try:
        trig = cli.get_trigger(name, "http")
        http = getattr(trig.body, "http_trigger", None) if trig.body else None
        if http:
            url = getattr(http, "url_internet", None) or getattr(http, "url_intranet", None)
            print("TRIGGER_URL", url)
    except Exception as e:
        print("GET_TRIG", str(e)[:200])
    try:
        cli.put_scaling_config(name, fc.PutScalingConfigRequest(body=fc.PutScalingConfigInput(
            horizontal_scaling_policies=[
                fc.ScalingPolicy(name="single", max_instances=1, min_instances=0,
                                 metric_type="CPUUtilization", metric_target=0.8),
            ],
        )))
        print("SCALE max_instances=1")
    except Exception as e:
        print("SCALE", type(e).__name__, str(e)[:240])
    if url:
        if name == DEFAULT_NAME:
            write_state({"REGION": REGION, "FC_FUNCTION": name, "PUBLIC_URL": url, "ACCOUNT_TAIL": aid[-4:]})
        else:
            write_state({"FC_TEST_FUNCTION": name, "TEST_URL": url})


if __name__ == "__main__":
    main()
