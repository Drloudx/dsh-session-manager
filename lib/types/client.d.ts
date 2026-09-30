/**
 * @dsh-external/session-console — client 面板。
 *
 * sidebar.footer.action：左下角「会话管理」入口（设置上方，IconListPenOutline16）→ 打开会话列表弹窗。
 * 数据源：host webServer API（/dsh-session-manager/api）——由 host 侧用 DSH 公开服务产出，
 * 可见性规则与官方侧边栏一致（隐藏空会话 / 归档 / 子代理），因此面板里的行 = 侧边栏里的行。
 *
 * 面板能力：工作区分组（可折叠）、标题、最近活动相对时间、轮次、日志大小、
 *          搜索、空/归档/子代理开关、未分组分组、空会话一键清理、单行删除。
 */
/** 本地最小契约（不 import DSH 包：编译不依赖 checkout，运行时由 __ModuleLoader__ 注入）。 */
type PrimitiveModule = Record<string, (props: any) => any>;
interface Window {
    __ModuleLoader__: {
        load: (entry: {
            id: string;
            factory: (require: (spec: string) => any) => unknown;
        }) => void;
    };
}
