@echo off
rem PATH shim: `ocl <args>` == `node <skill>\bin\ocl.mjs <args>`
node "%~dp0ocl.mjs" %*
