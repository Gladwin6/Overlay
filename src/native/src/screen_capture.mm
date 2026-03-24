#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#include <napi.h>

// CoreGraphics-only screen capture (no ScreenCaptureKit dependency)
// Works on macOS 10.15+ with screen recording permission

Napi::Value Capture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    @autoreleasepool {
        CGDirectDisplayID displayId = CGMainDisplayID();
        CGImageRef screenImage = CGDisplayCreateImage(displayId);

        if (!screenImage) {
            Napi::Error::New(env, "Failed to capture screen").ThrowAsJavaScriptException();
            return env.Undefined();
        }

        NSBitmapImageRep* bitmap = [[NSBitmapImageRep alloc] initWithCGImage:screenImage];
        CGImageRelease(screenImage);

        if (!bitmap) {
            Napi::Error::New(env, "Failed to create bitmap").ThrowAsJavaScriptException();
            return env.Undefined();
        }

        NSData* pngData = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];

        if (!pngData) {
            Napi::Error::New(env, "Failed to create PNG data").ThrowAsJavaScriptException();
            return env.Undefined();
        }

        Napi::Buffer<uint8_t> buffer = Napi::Buffer<uint8_t>::Copy(
            env,
            (uint8_t*)[pngData bytes],
            [pngData length]
        );

        return buffer;
    }
}

Napi::Value CaptureRegion(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 4) {
        Napi::TypeError::New(env, "Expected 4 arguments: x, y, width, height").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    int x = info[0].As<Napi::Number>().Int32Value();
    int y = info[1].As<Napi::Number>().Int32Value();
    int width = info[2].As<Napi::Number>().Int32Value();
    int height = info[3].As<Napi::Number>().Int32Value();

    @autoreleasepool {
        CGDirectDisplayID displayId = CGMainDisplayID();
        CGRect captureRect = CGRectMake(x, y, width, height);
        CGImageRef screenImage = CGDisplayCreateImageForRect(displayId, captureRect);

        if (!screenImage) {
            Napi::Error::New(env, "Failed to capture screen region").ThrowAsJavaScriptException();
            return env.Undefined();
        }

        NSBitmapImageRep* bitmap = [[NSBitmapImageRep alloc] initWithCGImage:screenImage];
        CGImageRelease(screenImage);

        if (!bitmap) {
            Napi::Error::New(env, "Failed to create bitmap").ThrowAsJavaScriptException();
            return env.Undefined();
        }

        NSData* pngData = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];

        if (!pngData) {
            Napi::Error::New(env, "Failed to create PNG data").ThrowAsJavaScriptException();
            return env.Undefined();
        }

        Napi::Buffer<uint8_t> buffer = Napi::Buffer<uint8_t>::Copy(
            env,
            (uint8_t*)[pngData bytes],
            [pngData length]
        );

        return buffer;
    }
}

Napi::Value GetDisplayInfo(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    CGDirectDisplayID displayId = CGMainDisplayID();

    Napi::Object result = Napi::Object::New(env);
    result.Set("width", (int)CGDisplayPixelsWide(displayId));
    result.Set("height", (int)CGDisplayPixelsHigh(displayId));
    result.Set("scaleFactor", (double)CGDisplayPixelsWide(displayId) / (double)CGDisplayBounds(displayId).size.width);

    return result;
}

Napi::Value CheckScreenRecordingPermission(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    CGImageRef testImage = CGWindowListCreateImage(
        CGRectMake(0, 0, 1, 1),
        kCGWindowListOptionOnScreenOnly,
        kCGNullWindowID,
        kCGWindowImageDefault
    );

    bool hasPermission = (testImage != nullptr);

    if (testImage) {
        CGImageRelease(testImage);
    }

    return Napi::Boolean::New(env, hasPermission);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("capture", Napi::Function::New(env, Capture));
    exports.Set("captureRegion", Napi::Function::New(env, CaptureRegion));
    exports.Set("getDisplayInfo", Napi::Function::New(env, GetDisplayInfo));
    exports.Set("checkScreenRecordingPermission", Napi::Function::New(env, CheckScreenRecordingPermission));
    return exports;
}

NODE_API_MODULE(screen_capture, Init)
