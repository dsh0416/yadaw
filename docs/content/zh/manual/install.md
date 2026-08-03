---
title: 安装 YADAW
description: 在 Windows、macOS 或 Linux 上下载并启动 YADAW。
vstTrademark: true
---

# 安装 YADAW

YADAW 会为每个带标签的发布版本提供 Windows、macOS 与 Linux 安装包。

## 下载发布版本

1. 打开 [YADAW 发布页面](https://github.com/dsh0416/yadaw/releases)。
2. 选择最新的发布版本并展开 **Assets**。
3. 下载适合你系统的文件：
   - **Windows x64：** `.exe`
   - **macOS（Apple 芯片或 Intel）：** 通用 `.dmg`
   - **Linux x64 或 arm64：** `.AppImage`
4. 如需校验下载内容，请保留随附的 `SHA256SUMS` 文件。

::: tip 没有可用的发布版本？
YADAW 仍处于实验阶段。如果发布页面还没有可用的安装包，可以按照
[开发环境指南](https://github.com/dsh0416/yadaw/blob/main/agents/docs/environment.md)
从源码构建。该流程面向贡献者。
:::

## Windows

运行下载的安装程序。Windows 音频构建包含 ASIO 支持。要进行低延迟工作，
请在打开 YADAW 前安装音频接口厂商提供的 64 位 ASIO 驱动。

如果 Windows 提示无法识别的应用，请确认下载来自官方仓库，并在继续前校验
其校验和。

## macOS

打开 `.dmg` 并将 YADAW 拖入“应用程序”。首次启动可能需要在
**系统设置 → 隐私与安全性** 中确认，对于实验性或未签名的构建尤其如此。

当 macOS 请求麦克风权限时请允许；YADAW 需要该权限才能从音频输入录音。

## Linux

为 AppImage 添加可执行权限，然后运行：

```sh
chmod +x YADAW-*.AppImage
./YADAW-*.AppImage
```

可用的设备取决于你的桌面音频配置。请确保运行 YADAW 的用户可以访问所选设备。

## 首次启动

YADAW 会扫描系统与用户的 VST® 3 位置，启动隔离的音频服务，并打开工程工作区。
插件较多时，首次扫描可能比之后的启动更慢。

继续阅读[第一个工程](first-project.md)。
