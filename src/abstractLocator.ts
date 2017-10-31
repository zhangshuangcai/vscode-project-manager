let walker = require("walker");
import path = require("path");
import fs = require("fs");
import vscode = require("vscode");
// import os = require("os");
import { homeDir, PathUtils } from "./PathUtils";
import { Project } from "./storage";

// const homeDir = os.homedir();
const CACHE_FILE = "projects_cache_";

export interface DirInfo {
    fullPath: string;
    name: string;
}
export interface DirList extends Array<DirInfo> { };

export abstract class AbstractLocator {

    public dirList: DirList = <DirList> [];
    private maxDepth: number;
    private ignoredFolders: string[];
    private useCachedProjects: boolean;
    private alreadyLocated: boolean;
    private baseFolders: string[];

    constructor() {
        this.maxDepth = -1;
        this.ignoredFolders = [];
        this.useCachedProjects = true;
        this.alreadyLocated = false;
        this.baseFolders = [];
        this.refreshConfig();
    }

    public abstract getKind(): string;
    public abstract getDisplayName(): string;
    public abstract decideProjectName(projectPath: string): string;
    public abstract isRepoDir(projectPath: string): boolean;

    public getPathDepth(s) {
        return s.split(path.sep).length;
    }

    public isMaxDeptReached(currentDepth, initialDepth) {
        return (this.maxDepth > 0) && ((currentDepth - initialDepth) > this.maxDepth);
    }

    public isFolderIgnored(folder) {
        return this.ignoredFolders.indexOf(folder) !== -1;
    }

    public isAlreadyLocated(): boolean {
        return this.useCachedProjects && this.alreadyLocated;
    }

    public setAlreadyLocated(al: boolean): void {
        if (this.useCachedProjects) {
            this.alreadyLocated = al;
            if (this.alreadyLocated) {
                let cacheFile: string = this.getCacheFile();
                fs.writeFileSync(cacheFile, JSON.stringify(this.dirList, null, "\t"), { encoding: "utf8" });
            }
        }
    }

    public clearDirList() {
        this.dirList = [];
    }

    public initializeCfg(kind: string) {

        if (!this.useCachedProjects) {
            this.clearDirList();
        } else {
            let cacheFile: string = this.getCacheFile();
            if (fs.existsSync(cacheFile)) {
                this.dirList = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
                this.setAlreadyLocated(true);
            }
        }
    }

    public locateProjects() {

        const projectsDirList = this.baseFolders;

        return new Promise<DirList>((resolve, reject) => {

            if (projectsDirList.length === 0) {
                resolve(<DirList> []);
                return;
            }

            this.initializeCfg(this.getKind());
            if (this.isAlreadyLocated()) {
                resolve(this.dirList);
                return;
            }

            let promises = [];
            this.clearDirList();

            projectsDirList.forEach((projectBasePath) => {
                let expandedBasePath: string = PathUtils.expandHomePath(projectBasePath);
                if (!fs.existsSync(expandedBasePath)) {
                    vscode.window.setStatusBarMessage("Directory " + expandedBasePath + " does not exists.", 1500);

                    return;
                }

                let depth = this.getPathDepth(expandedBasePath);

                let promise = new Promise((resolve, reject) => {
                    try {
                        walker(expandedBasePath)
                            .filterDir((dir, stat) => {
                                return !(this.isFolderIgnored(path.basename(dir)) ||
                                    this.isMaxDeptReached(this.getPathDepth(dir), depth));
                            })
                            .on("dir", this.processDirectory)
                            .on("error", this.handleError)
                            .on("end", () => {
                                resolve();
                            });
                    } catch (error) {
                        reject(error);
                    }

                });
                promises.push(promise);
            });

            Promise.all(promises)
                .then(() => {
                    vscode.window.setStatusBarMessage("Searching folders completed", 1500);
                    this.setAlreadyLocated(true);
                    resolve(this.dirList);
                })
                .catch(error => { vscode.window.showErrorMessage("Error while loading projects."); });
        });
    }

    public addToList(projectPath: string, projectName: string = null) {
        this.dirList.push({
            fullPath: projectPath,
            name: projectName === null ? path.basename(projectPath) : projectName
        });
        return;
    }

    public processDirectory = (absPath: string, stat: any) => {
        vscode.window.setStatusBarMessage(absPath, 600);
        if (this.isRepoDir(absPath)) {
            this.addToList(absPath, this.decideProjectName(absPath));
        }
    }

    public handleError(err) {
        console.log("Error walker:", err);
    }

    public refreshProjects(): boolean {
        const configChanged = this.refreshConfig();
        this.clearDirList();
        let cacheFile: string = this.getCacheFile();
        if (fs.existsSync(cacheFile)) {
            fs.unlinkSync(cacheFile);
        }
        this.setAlreadyLocated(false);
        this.locateProjects();

        return configChanged;
    }

    public existsWithRootPath(rootPath: string): Project {
        
        // it only works if using `cache`
        this.initializeCfg(this.getKind());
        if (!this.isAlreadyLocated()) {
            return null;
        }

        let rootPathUsingHome: string = PathUtils.compactHomePath(rootPath).toLocaleLowerCase();
        for (let element of this.dirList) {
            if ((element.fullPath.toLocaleLowerCase() === rootPath.toLocaleLowerCase()) || (element.fullPath.toLocaleLowerCase() === rootPathUsingHome)) {
                return {
                    rootPath: element.fullPath,
                    name: element.name,
                    group: "",
                    paths: [] 
                };
            }
        }
    }

    private getChannelPath(): string {
        if (vscode.env.appName.indexOf("Insiders") > 0) {
            return "Code - Insiders";
        } else {
            return "Code";
        }
    }

    private getCacheFile() {
        let cacheFile: string;
        let appdata = process.env.APPDATA || (process.platform === "darwin" ? process.env.HOME + "/Library/Application Support" : "/var/local");
        let channelPath: string = this.getChannelPath();
        cacheFile = path.join(appdata, channelPath, "User", CACHE_FILE + this.getKind() + ".json");
        if ((process.platform === "linux") && (!fs.existsSync(cacheFile))) {
            cacheFile = path.join(homeDir, ".config/", channelPath, "User", CACHE_FILE + this.getKind() + ".json");
        }
        return cacheFile;
    }

    private refreshConfig(): boolean {
        const config = vscode.workspace.getConfiguration("projectManager");
        let refreshedSomething: boolean = false;
        let currentValue = null;

        currentValue = config.get<string[]>(this.getKind() + ".baseFolders");
        if (!this.arraysAreEquals(this.baseFolders, currentValue)) {
            this.baseFolders = currentValue;
            refreshedSomething = true;
        }

        currentValue = config.get<string[]>(this.getKind() + ".ignoredFolders", []);
        if (!this.arraysAreEquals(this.baseFolders, currentValue)) {
            this.ignoredFolders = currentValue;
            refreshedSomething = true;
        }        

        currentValue = config.get(this.getKind() + ".maxDepthRecursion", -1);
        if (this.maxDepth != currentValue) {
            this.maxDepth = currentValue;
            refreshedSomething = true;
        }

        currentValue = config.get("cacheProjectsBetweenSessions", true);
        if (this.useCachedProjects != currentValue) {
            this.useCachedProjects = currentValue;
            refreshedSomething = true;
        }

        return refreshedSomething;
    }

    private arraysAreEquals(array1, array2): boolean {
        if (!array1 || !array2) {
            return false;
        }

        if (array1.length !== array2.length) {
            return false;
        }

        for (let i = 0, l = array1.length; i < l; i++) {
            if (array1[i] instanceof Array && array2[i] instanceof Array) {
                if (!array1[i].equals(array2[i])) {
                    return false;
                }
            } else {
                if (array1[i] !== array2[i]) {
                    return false;
                }
            }
        }
        return true;
    }

}