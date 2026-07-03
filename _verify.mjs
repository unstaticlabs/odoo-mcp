import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const H = { Authorization:`Bearer ${process.env.ODOO_API_KEY}`, "X-Odoo-Url":process.env.ODOO_DEFAULT_BASE_URL, "X-Odoo-Db":process.env.ODOO_DEFAULT_DB };
const t = new StreamableHTTPClientTransport(new URL("http://localhost:8795/mcp"), { requestInit:{ headers:H } });
const c = new Client({ name:"verify", version:"0.0.1" }, { capabilities:{} });
await c.connect(t);
console.log("TOOLS:", (await c.listTools()).tools.map(x=>x.name).sort().join(", "));
async function call(name,args){ for(let i=0;i<3;i++){ try{
  const r=await c.callTool({name,arguments:args},undefined,{timeout:25000});
  return (r.content?.map(x=>x.text).join(" ")??"").replace(/\s+/g," ").slice(0,120);
}catch(e){ if(i===2) return "ERR:"+e.message; } } }
console.log("search_records:", await call("search_records",{model:"project.task",domain:[["project_id","=",17]],fields:["id","name"],limit:2}));
console.log("get_record:    ", await call("get_record",{model:"project.task",record_id:1057,fields:["id","name"]}));
console.log("list_models:   ", (await call("list_models",{}))?.slice(0,80));
console.log("get_fields:    ", (await call("get_fields",{model:"project.task"}))?.slice(0,80));
await c.close();
