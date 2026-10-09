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


MODEL_KEYS = ("LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY", "DEEPSEEK_API_KEY", "OPENAI_API_KEY", "LLM_REASONING_EFFORT")


def llm_settings() -> dict[str, str]:
    """本机要发上去的模型设置：地址、模型、密钥一整组。本机没有密钥就返回空——函数上现有的那组原样保留。
    只换密钥不换地址会配错：函数上用的是别家的地址，本机留着 DeepSeek 的密钥，发版之后模型就认证失败（Codex 复现）。"""
    app_env = load_env(Path(__file__).resolve().parents[2] / ".env")
    root_env = load_env()
    src = app_env if app_env.get("LLM_API_KEY") else root_env
    key = src.get("LLM_API_KEY") or src.get("DEEPSEEK_API_KEY") or ""
    if not key:
        return {}
    group = {"LLM_BASE_URL": src.get("LLM_BASE_URL") or "https://api.deepseek.com/v1",
             "LLM_MODEL": src.get("LLM_MODEL") or "deepseek-flash", "LLM_API_KEY": key}
    if "api.deepseek.com" in group["LLM_BASE_URL"]:
        group["DEEPSEEK_API_KEY"] = key
    if src.get("LLM_REASONING_EFFORT"):  # 推理强度也是这一组的：不写就清掉，免得留着函数上原来的 max（Codex 复现）
        group["LLM_REASONING_EFFORT"] = src["LLM_REASONING_EFFORT"]
    return group


def existing_env(cli: Client, name: str) -> dict[str, str]:
    """函数上现有的环境变量（控制台里配的公众号密钥、挂了 NAS 之后的库路径……）。取不到（函数还没建）就是空的。"""
    try:
        got = cli.get_function(name, fc.GetFunctionRequest())
        return dict((got.body.environment_variables or {}) if got.body else {})
    except Exception:
        return {}


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
    # 更新是整份换掉环境变量：在函数现有的那份上改，不然每发一次版，控制台里配的 WECHAT_*（微信登录）就没了、
    # 挂了 NAS 之后改成的 QIYAN_DB 又被写回 /tmp（学生的账号和记录全看不到，Codex 复现）。
    # 库路径：本机 .env 写了 QIYAN_DB 就用它；否则保留函数上现有的；都没有才用 /tmp（实例回收就丢，见 docs/DEPLOY.md）
    current = existing_env(cli, name)
    db_name = (env.get("QIYAN_DB") or current.get("QIYAN_DB")
               or ("/tmp/qiyan-test.db" if name != DEFAULT_NAME else "/tmp/qiyan.db"))
    local_llm = llm_settings()
    if local_llm:  # 整组换成本机的；本机没有就整组留函数上的
        current = {k: v for k, v in current.items() if k not in MODEL_KEYS}
    env_vars = {
        "LLM_BASE_URL": "https://api.deepseek.com/v1",
        "LLM_MODEL": "deepseek-flash",
        **current,
        **local_llm,
        "QIYAN_DB": db_name,
        "QIYAN_ENV": "test" if name != DEFAULT_NAME else "prod",
    }
    print("QIYAN_DB", db_name, "MODEL", env_vars["LLM_MODEL"], "KEY", "local" if local_llm else ("kept" if env_vars.get("LLM_API_KEY") else "none"))
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
