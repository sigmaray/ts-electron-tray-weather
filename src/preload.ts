import { contextBridge, ipcRenderer } from 'electron';
import { Settings } from './settings';

contextBridge.exposeInMainWorld('weatherSettings', {
  save: (settings: Settings) => ipcRenderer.invoke('settings:save', settings),
});
