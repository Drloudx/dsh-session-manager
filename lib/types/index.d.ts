/**
 * 本地最小 cordis 上下文契约（刻意不 import 'cordis' / '@deepseek-ai/*'：
 * 插件保持零外部运行时依赖，编译也不需要 DSH 源码 checkout）。
 */
type AppContext = {
    effect: (fn: () => unknown, label?: string) => void;
    tools: {
        register: (tool: unknown) => unknown;
    };
    webServer: {
        register: (route: unknown, label?: string) => unknown;
    };
    get?: (key: string) => any;
    [key: string]: any;
};
export declare const name = "@dsh-external/session-console";
export declare const inject: string[];
export declare function apply(ctx: AppContext, config?: {
    dshHome?: string;
}): void;
export {};
