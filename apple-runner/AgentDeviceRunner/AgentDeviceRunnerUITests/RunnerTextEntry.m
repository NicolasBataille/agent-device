#import "RunnerTextEntry.h"

#import <objc/message.h>
#import <objc/runtime.h>

typedef void (*RunnerMsgSendTypeTextWithSpeed)(id, SEL, NSString *, NSUInteger, double, BOOL);

@implementation RunnerTextEntry

+ (NSString * _Nullable)typeText:(NSString *)text
                      intoElement:(id)element
                      typingSpeed:(double)typingSpeed {
  SEL selector = NSSelectorFromString(@"typeText:atOffset:typingSpeed:shouldRedact:");
  if (element == nil || ![element respondsToSelector:selector]) {
    return [NSString stringWithFormat:
      @"private XCTest text entry unavailable: selector missing on %@ (%@)",
      NSStringFromClass([element class]),
      [self textEntrySelectorListForElement:element]
    ];
  }

  @try {
    ((RunnerMsgSendTypeTextWithSpeed)objc_msgSend)(element, selector, text, 0, typingSpeed, NO);
  } @catch (NSException *exception) {
    NSString *name = exception.name ?: @"NSException";
    NSString *reason = exception.reason ?: @"private XCTest text entry failed";
    return [NSString stringWithFormat:@"%@: %@", name, reason];
  }
  return nil;
}

+ (NSString *)textEntrySelectorListForElement:(id)element {
  NSMutableArray<NSString *> *selectors = [NSMutableArray array];
  Class cls = [element class];
  while (cls != Nil) {
    unsigned int count = 0;
    Method *methods = class_copyMethodList(cls, &count);
    for (unsigned int index = 0; index < count; index += 1) {
      SEL selector = method_getName(methods[index]);
      NSString *name = NSStringFromSelector(selector);
      if ([name containsString:@"type"] || [name containsString:@"Text"] || [name containsString:@"keyboard"]) {
        [selectors addObject:[NSString stringWithFormat:@"%@:%@", NSStringFromClass(cls), name]];
      }
    }
    free(methods);
    cls = class_getSuperclass(cls);
  }
  return [selectors componentsJoinedByString:@", "];
}

@end
