#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface RunnerTextEntry : NSObject

+ (NSString * _Nullable)typeText:(NSString *)text
                      intoElement:(id)element
                      typingSpeed:(double)typingSpeed;

@end

NS_ASSUME_NONNULL_END
