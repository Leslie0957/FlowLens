// Display labels only. The persisted status and server eligibility stay authoritative.
const statuses:Record<string,string>={QUEUED:'等待处理',RUNNING:'处理中',FAILED:'失败',CANCELLED:'已取消',INTERRUPTED:'服务重启中断',PRECHECK_PASSED:'预检通过',SUCCEEDED:'执行成功',PENDING_APPROVAL:'待批准修复',VERIFYING:'隔离验证中',VERIFIED:'验证通过',VERIFICATION_FAILED:'验证失败',REJECTED:'候选已拒绝',STALE:'版本已变化',EXPIRED:'候选已过期',NO_CANDIDATE:'无修复候选',COMPLETED:'已完成',COMMITTED:'已入库',RESTORED:'已撤销'};
export const statusLabel=(status:string)=>statuses[status]??status;
export const statusTone=(status:string)=>['FAILED','VERIFICATION_FAILED','INTERRUPTED'].includes(status)?'danger':['PRECHECK_PASSED','SUCCEEDED','VERIFIED','COMPLETED','COMMITTED'].includes(status)?'success':['PENDING_APPROVAL','QUEUED','RUNNING','VERIFYING'].includes(status)?'active':'muted';
const tools:Record<string,string>={get_execution:'执行信息',get_sql:'任务 SQL',get_schema:'实际表结构',get_logs:'运行日志',get_output_preview:'输出与校验',get_task_contract:'业务规则'};
export const toolLabel=(name:string)=>tools[name]??name;
export const stepLabel=(step:string)=>({query:'SQL 查询',validate:'结果校验',precheck:'入库预检',verification:'隔离验证'}[step]??step);
export const localTime=(value:string)=>{const date=new Date(value);return Number.isNaN(date.getTime())?value:date.toLocaleString('zh-CN',{hour12:false});};
